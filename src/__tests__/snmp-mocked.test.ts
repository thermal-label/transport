import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NetworkInterfaceInfo } from 'node:os';
import { TransportError } from '@thermal-label/contracts';
import type * as SnmpModule from '../node/snmp.js';
import type { SnmpMessage, SnmpValue } from '../node/snmp.js';

type SendCb = (err?: Error) => void;

class MockSocket extends EventEmitter {
  sends: { msg: Uint8Array; port: number; address: string }[] = [];
  broadcast: boolean | undefined;
  setBroadcastImpl = (flag: boolean): void => {
    this.broadcast = flag;
  };
  sendImpl = (_msg: Uint8Array, _port: number, _address: string, cb: SendCb): void => {
    setImmediate(cb);
  };
  close = vi.fn();
  bind(cb: () => void): void {
    setImmediate(cb);
  }
  setBroadcast(flag: boolean): void {
    this.setBroadcastImpl(flag);
  }
  send(msg: Uint8Array, port: number, address: string, cb: SendCb): void {
    this.sends.push({ msg, port, address });
    this.sendImpl(msg, port, address, cb);
  }
}

let lastSocket: MockSocket | undefined;
const createSocket = vi.fn(() => {
  lastSocket = new MockSocket();
  return lastSocket;
});
vi.mock('node:dgram', () => ({ createSocket: (): MockSocket => createSocket() }));

let interfaces: Record<string, NetworkInterfaceInfo[]> = {};
vi.mock('node:os', () => ({
  networkInterfaces: (): Record<string, NetworkInterfaceInfo[]> => interfaces,
}));

function v4(address: string, netmask: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask, family: 'IPv4', mac: '00:00:00:00:00:00', internal, cidr: null };
}
function v6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
    scopeid: 0,
  };
}

async function load(): Promise<typeof SnmpModule> {
  return import('../node/snmp.js');
}

const HR_DEVICE_DESCR = '1.3.6.1.2.1.25.3.2.1.3.1';

async function answer(
  snmp: typeof SnmpModule,
  address: string,
  value: SnmpValue,
  overrides: Partial<SnmpMessage> = {},
): Promise<void> {
  const msg: SnmpMessage = {
    community: 'public',
    pduType: 'get-response',
    requestId: 1,
    errorStatus: 0,
    errorIndex: 0,
    varbinds: [{ oid: HR_DEVICE_DESCR, value }],
    ...overrides,
  };
  // let bind() + the first sendAll run before the reply lands
  await new Promise(resolve => setTimeout(resolve, 5));
  lastSocket?.emit('message', Buffer.from(snmp.encodeSnmpMessage(msg)), { address, port: 161 });
}

const str = (value: string): SnmpValue => ({
  type: 'string',
  value,
  raw: Uint8Array.from(Buffer.from(value, 'latin1')),
});

describe('snmpBroadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSocket = undefined;
    interfaces = {
      lo: [v4('127.0.0.1', '255.0.0.0', true)],
      wlp5s0: [v4('192.168.1.10', '255.255.255.0'), v6('fe80::1')],
      enp6s0: [v4('192.168.1.11', '255.255.255.0')],
      tun0: [v4('10.8.0.2', '255.255.255.255')],
    };
  });

  it('resolves [] without a socket when no broadcast-capable interface exists', async () => {
    interfaces = {
      lo: [v4('127.0.0.1', '255.0.0.0', true)],
      tun0: [v4('10.8.0.2', '255.255.255.255')],
    };
    const { snmpBroadcast } = await load();
    await expect(snmpBroadcast(HR_DEVICE_DESCR, { windowMs: 10 })).resolves.toEqual([]);
    expect(createSocket).not.toHaveBeenCalled();
  });

  it('sends one directed broadcast per subnet (two interfaces on one LAN → one target)', async () => {
    const snmp = await load();
    const result = await snmp.snmpBroadcast(HR_DEVICE_DESCR, { windowMs: 30, retries: 0 });
    expect(result).toEqual([]);
    expect(lastSocket?.broadcast).toBe(true);
    expect(lastSocket?.sends.map(s => `${s.address}:${String(s.port)}`)).toEqual([
      '192.168.1.255:161',
    ]);
    const sent = snmp.decodeSnmpMessage(lastSocket?.sends[0]?.msg ?? new Uint8Array());
    expect(sent).toMatchObject({ community: 'public', pduType: 'get-request', requestId: 1 });
    expect(sent.varbinds).toEqual([{ oid: HR_DEVICE_DESCR, value: { type: 'null' } }]);
    expect(lastSocket?.close).toHaveBeenCalledOnce();
  });

  it('covers every subnet and spreads resends over the window', async () => {
    interfaces = {
      a: [v4('10.0.0.5', '255.0.0.0')],
      b: [v4('192.168.1.10', '255.255.255.0')],
    };
    const { snmpBroadcast } = await load();
    await snmpBroadcast(HR_DEVICE_DESCR, {
      windowMs: 40,
      retries: 1,
      community: 'bench',
      port: 1161,
    });
    const sends = lastSocket?.sends ?? [];
    expect(sends.map(s => s.address).sort()).toEqual([
      '10.255.255.255',
      '10.255.255.255',
      '192.168.1.255',
      '192.168.1.255',
    ]);
    expect(sends.every(s => s.port === 1161)).toBe(true);
  });

  it('lists each responder once, first answer wins, non-string answers included', async () => {
    const snmp = await load();
    const pending = snmp.snmpBroadcast(HR_DEVICE_DESCR, { windowMs: 60, retries: 1 });
    await answer(snmp, '192.168.1.67', str('Brother QL-820NWB'));
    await answer(snmp, '192.168.1.1', { type: 'noSuchObject' });
    await answer(snmp, '192.168.1.67', str('duplicate from the resend'));
    // v1 agent without the object: errorStatus noSuchName → noSuchObject
    await answer(snmp, '192.168.1.2', { type: 'null' }, { errorStatus: 2, errorIndex: 1 });
    // wrong request id and garbage: ignored
    await answer(snmp, '192.168.1.3', str('stale'), { requestId: 99 });
    lastSocket?.emit('message', Buffer.from([0x01, 0x02]), { address: '192.168.1.4', port: 161 });
    await expect(pending).resolves.toEqual([
      { address: '192.168.1.67', value: str('Brother QL-820NWB') },
      { address: '192.168.1.1', value: { type: 'noSuchObject' } },
      { address: '192.168.1.2', value: { type: 'noSuchObject' } },
    ]);
  });

  it('ignores per-interface send failures (callback error and synchronous throw)', async () => {
    interfaces = {
      a: [v4('10.0.0.5', '255.0.0.0')],
      b: [v4('192.168.1.10', '255.255.255.0')],
    };
    createSocket.mockImplementationOnce(() => {
      lastSocket = new MockSocket();
      lastSocket.sendImpl = (_m, _p, address, cb) => {
        if (address.startsWith('10.')) throw new Error('ENETUNREACH');
        setImmediate(() => {
          cb(new Error('EACCES'));
        });
      };
      return lastSocket;
    });
    const snmp = await load();
    const pending = snmp.snmpBroadcast(HR_DEVICE_DESCR, { windowMs: 30, retries: 0 });
    await answer(snmp, '192.168.1.67', str('Brother QL-820NWB'));
    await expect(pending).resolves.toHaveLength(1);
  });

  it('rejects with TransportError on a socket error', async () => {
    const { snmpBroadcast } = await load();
    const pending = snmpBroadcast(HR_DEVICE_DESCR, { windowMs: 100 });
    await new Promise(resolve => setTimeout(resolve, 5));
    lastSocket?.emit('error', new Error('EADDRNOTAVAIL'));
    await expect(pending).rejects.toBeInstanceOf(TransportError);
    expect(lastSocket?.close).toHaveBeenCalledOnce();
  });

  it('rejects with TransportError when broadcast cannot be enabled', async () => {
    createSocket.mockImplementationOnce(() => {
      lastSocket = new MockSocket();
      lastSocket.setBroadcastImpl = () => {
        throw new Error('EBADF');
      };
      return lastSocket;
    });
    const { snmpBroadcast } = await load();
    await expect(snmpBroadcast(HR_DEVICE_DESCR, { windowMs: 100 })).rejects.toThrow(
      /broadcast not permitted: EBADF/,
    );
    expect(lastSocket?.sends).toEqual([]);
  });

  it('skips interfaces with malformed addresses or netmasks', async () => {
    interfaces = {
      bad: [v4('192.168.1', '255.255.255.0'), v4('192.168.1.10', 'not-a-mask')],
      good: [v4('172.16.4.9', '255.255.0.0')],
    };
    const { snmpBroadcast } = await load();
    await snmpBroadcast(HR_DEVICE_DESCR, { windowMs: 10, retries: 0 });
    expect(lastSocket?.sends.map(s => s.address)).toEqual(['172.16.255.255']);
  });

  it('tolerates close() throwing after an error', async () => {
    createSocket.mockImplementationOnce(() => {
      lastSocket = new MockSocket();
      lastSocket.close = vi.fn(() => {
        throw new Error('ERR_SOCKET_DGRAM_NOT_RUNNING');
      });
      return lastSocket;
    });
    const { snmpBroadcast } = await load();
    const pending = snmpBroadcast(HR_DEVICE_DESCR, { windowMs: 100 });
    await new Promise(resolve => setTimeout(resolve, 5));
    lastSocket?.emit('error', new Error('boom'));
    await expect(pending).rejects.toBeInstanceOf(TransportError);
  });
});

describe('snmpGet (mocked socket)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastSocket = undefined;
  });

  it('rejects with TransportError on a socket error, even when close() throws', async () => {
    createSocket.mockImplementationOnce(() => {
      lastSocket = new MockSocket();
      lastSocket.close = vi.fn(() => {
        throw new Error('ERR_SOCKET_DGRAM_NOT_RUNNING');
      });
      return lastSocket;
    });
    const { snmpGet } = await load();
    const pending = snmpGet('192.0.2.1', [HR_DEVICE_DESCR], { timeoutMs: 100, retries: 0 });
    await new Promise(resolve => setTimeout(resolve, 5));
    lastSocket?.emit('error', new Error('EHOSTUNREACH'));
    await expect(pending).rejects.toThrow(/SNMP socket error: EHOSTUNREACH/);
    expect(lastSocket?.close).toHaveBeenCalledOnce();
  });
});
