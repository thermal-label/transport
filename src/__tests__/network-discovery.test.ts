import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportTimeoutError } from '@thermal-label/contracts';
import type { DeviceEntry } from '@thermal-label/contracts';
import type * as DiscoveryModule from '../node/discovery.js';
import type * as SnmpModule from '../node/snmp.js';
import type { SnmpValue } from '../node/snmp.js';

const snmpGet =
  vi.fn<
    (host: string, oids: readonly string[], opts?: unknown) => Promise<Record<string, SnmpValue>>
  >();
const snmpBroadcast =
  vi.fn<(oid: string, opts?: unknown) => Promise<{ address: string; value: SnmpValue }[]>>();

vi.mock('../node/snmp.js', async () => {
  const actual = await vi.importActual<typeof SnmpModule>('../node/snmp.js');
  return {
    PRINTER_MIB: actual.PRINTER_MIB,
    snmpGet: (...args: Parameters<typeof snmpGet>) => snmpGet(...args),
    snmpBroadcast: (...args: Parameters<typeof snmpBroadcast>) => snmpBroadcast(...args),
  };
});

const HR_DEVICE_DESCR = '1.3.6.1.2.1.25.3.2.1.3.1';
const SYS_DESCR = '1.3.6.1.2.1.1.1.0';
const SERIAL = '1.3.6.1.2.1.43.5.1.1.17.1';

const str = (value: string): SnmpValue => ({
  type: 'string',
  value,
  raw: Uint8Array.from(Buffer.from(value, 'latin1')),
});
const none: SnmpValue = { type: 'noSuchObject' };

const engine = { role: 'primary', protocol: 'test', dpi: 300, headDots: 720 } as const;
function entry(key: string, name: string, extra: Partial<DeviceEntry> = {}): DeviceEntry {
  return {
    key,
    name,
    family: 'brother-ql',
    transports: { tcp: { port: 9100 } },
    engines: [engine],
    support: { status: 'untested' },
    ...extra,
  };
}

const QL_820NWBc = entry('QL_820NWBc', 'QL-820NWBc', { modelNames: ['QL-820NWB', 'QL-820NWBc'] });
const PT_E550W = entry('PT_E550W', 'PT-E550W', { transports: { tcp: { port: 9101 } } });
const QL_800 = entry('QL_800', 'QL-800', { transports: { usb: { vid: '04f9', pid: '209b' } } });
const REGISTRY = [PT_E550W, QL_800, QL_820NWBc];

// Per-host answer tables for the mocked unicast.
let hosts: Record<string, Record<string, SnmpValue> | Error> = {};

async function load(): Promise<typeof DiscoveryModule> {
  return import('../node/discovery.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  hosts = {
    '192.168.1.67': {
      [HR_DEVICE_DESCR]: str('Brother QL-820NWB'),
      [SYS_DESCR]: str('Brother NC-8800w, Firmware Ver.1.20'),
      [SERIAL]: str('M5G679125'),
    },
    '192.168.1.1': { [HR_DEVICE_DESCR]: none, [SYS_DESCR]: str('RouterOS'), [SERIAL]: none },
    '192.168.1.5': {
      [HR_DEVICE_DESCR]: none,
      [SYS_DESCR]: str('Brother PT-E550W print server'),
      [SERIAL]: str('E55-0001'),
    },
    '192.168.1.9': { [HR_DEVICE_DESCR]: none, [SYS_DESCR]: none, [SERIAL]: none },
    '192.168.1.66': { [HR_DEVICE_DESCR]: str('Brother QL-800'), [SERIAL]: str('USB-ONLY') },
    '10.0.0.2': new TransportTimeoutError('tcp', 2000),
  };
  snmpGet.mockImplementation((host, oids) => {
    const table = hosts[host];
    if (table === undefined) return Promise.reject(new TransportTimeoutError('tcp', 2000));
    if (table instanceof Error) return Promise.reject(table);
    const out: Record<string, SnmpValue> = {};
    for (const oid of oids) {
      const v = table[oid];
      if (v !== undefined) out[oid] = v;
    }
    return Promise.resolve(out);
  });
  snmpBroadcast.mockResolvedValue([]);
});

describe('identifyNetworkDevice', () => {
  it('matches hrDeviceDescr against modelNames and reads the serial', async () => {
    const { identifyNetworkDevice } = await load();
    const found = await identifyNetworkDevice('192.168.1.67', REGISTRY, { community: 'bench' });
    expect(found).toEqual({
      descriptor: QL_820NWBc,
      host: '192.168.1.67',
      port: 9100,
      serialNumber: 'M5G679125',
      modelName: 'Brother QL-820NWB',
      connectionId: '192.168.1.67:9100',
    });
    expect(snmpGet).toHaveBeenCalledOnce();
    expect(snmpGet).toHaveBeenCalledWith('192.168.1.67', [HR_DEVICE_DESCR, SYS_DESCR, SERIAL], {
      community: 'bench',
    });
  });

  it('falls back to sysDescr when hrDeviceDescr.1 is absent', async () => {
    const { identifyNetworkDevice } = await load();
    const found = await identifyNetworkDevice('192.168.1.5', REGISTRY);
    expect(found?.descriptor).toBe(PT_E550W);
    expect(found?.port).toBe(9101);
    expect(found?.modelName).toBe('Brother PT-E550W print server');
    expect(found?.connectionId).toBe('192.168.1.5:9101');
  });

  it('falls back to sysDescr when hrDeviceDescr.1 is present but matches nothing', async () => {
    hosts['192.168.1.5'] = {
      [HR_DEVICE_DESCR]: str('Ethernet interface'),
      [SYS_DESCR]: str('Brother PT-E550W print server'),
      [SERIAL]: str('E55-0001'),
    };
    const { identifyNetworkDevice } = await load();
    const found = await identifyNetworkDevice('192.168.1.5', REGISTRY);
    expect(found?.descriptor).toBe(PT_E550W);
    expect(found?.modelName).toBe('Brother PT-E550W print server');
    expect(found?.serialNumber).toBe('E55-0001');
    expect(snmpGet).toHaveBeenCalledOnce();
  });

  it('resolves undefined when the host answered but is not in the registry', async () => {
    const { identifyNetworkDevice } = await load();
    await expect(identifyNetworkDevice('192.168.1.1', REGISTRY)).resolves.toBeUndefined();
    await expect(identifyNetworkDevice('192.168.1.9', REGISTRY)).resolves.toBeUndefined();
  });

  it('ignores registry entries without a TCP transport', async () => {
    const { identifyNetworkDevice } = await load();
    await expect(identifyNetworkDevice('192.168.1.66', REGISTRY)).resolves.toBeUndefined();
  });

  it('omits serialNumber when the agent does not answer it', async () => {
    hosts['192.168.1.67'] = { [HR_DEVICE_DESCR]: str('Brother QL-820NWB'), [SERIAL]: none };
    const { identifyNetworkDevice } = await load();
    const found = await identifyNetworkDevice('192.168.1.67', REGISTRY);
    expect(found?.descriptor.key).toBe('QL_820NWBc');
    expect(found && 'serialNumber' in found).toBe(false);
  });

  it('rejects when the host could not be asked', async () => {
    const { identifyNetworkDevice } = await load();
    await expect(identifyNetworkDevice('10.0.0.2', REGISTRY)).rejects.toBeInstanceOf(
      TransportTimeoutError,
    );
  });
});

describe('enumerateNetworkDevices', () => {
  it('sends nothing when no registry entry is TCP-capable', async () => {
    const { enumerateNetworkDevices } = await load();
    await expect(enumerateNetworkDevices([QL_800])).resolves.toEqual([]);
    expect(snmpBroadcast).not.toHaveBeenCalled();
  });

  it('broadcasts hrDeviceDescr, matches responders and fetches serials', async () => {
    snmpBroadcast.mockResolvedValue([
      { address: '192.168.1.67', value: str('Brother QL-820NWB') },
      { address: '192.168.1.1', value: none },
      { address: '192.168.1.66', value: str('Brother QL-800') },
    ]);
    const { enumerateNetworkDevices } = await load();
    const found = await enumerateNetworkDevices(REGISTRY, { windowMs: 500, community: 'bench' });
    expect(found).toEqual([
      {
        descriptor: QL_820NWBc,
        host: '192.168.1.67',
        port: 9100,
        serialNumber: 'M5G679125',
        modelName: 'Brother QL-820NWB',
        connectionId: '192.168.1.67:9100',
      },
    ]);
    expect(snmpBroadcast).toHaveBeenCalledWith(HR_DEVICE_DESCR, {
      windowMs: 500,
      community: 'bench',
    });
    // serial for the match; full identify (sysDescr fallback) for the
    // noSuchObject responder and for the unmatched USB-only model
    expect(snmpGet.mock.calls.map(([host, oids]) => [host, oids.length])).toEqual([
      ['192.168.1.67', 1],
      ['192.168.1.1', 3],
      ['192.168.1.66', 3],
    ]);
  });

  it('identifies responders whose hrDeviceDescr.1 matches nothing through sysDescr', async () => {
    hosts['192.168.1.5'] = {
      [HR_DEVICE_DESCR]: str('Ethernet interface'),
      [SYS_DESCR]: str('Brother PT-E550W print server'),
      [SERIAL]: str('E55-0001'),
    };
    snmpBroadcast.mockResolvedValue([{ address: '192.168.1.5', value: str('Ethernet interface') }]);
    const { enumerateNetworkDevices } = await load();
    const found = await enumerateNetworkDevices(REGISTRY);
    expect(found.map(f => [f.descriptor.key, f.serialNumber])).toEqual([['PT_E550W', 'E55-0001']]);
  });

  it('identifies responders without hrDeviceDescr.1 through the sysDescr fallback', async () => {
    snmpBroadcast.mockResolvedValue([{ address: '192.168.1.5', value: none }]);
    const { enumerateNetworkDevices } = await load();
    const found = await enumerateNetworkDevices(REGISTRY);
    expect(found.map(f => [f.descriptor.key, f.serialNumber])).toEqual([['PT_E550W', 'E55-0001']]);
  });

  it('keeps a match whose serial fetch fails, without a serial', async () => {
    snmpBroadcast.mockResolvedValue([{ address: '10.0.0.2', value: str('Brother QL-820NWB') }]);
    const { enumerateNetworkDevices } = await load();
    const found = await enumerateNetworkDevices(REGISTRY);
    expect(found).toHaveLength(1);
    expect(found[0] && 'serialNumber' in found[0]).toBe(false);
  });

  it('drops a fallback responder that stops answering, keeps the rest', async () => {
    snmpBroadcast.mockResolvedValue([
      { address: '10.0.0.2', value: none },
      { address: '192.168.1.67', value: str('Brother QL-820NWB') },
    ]);
    const { enumerateNetworkDevices } = await load();
    const found = await enumerateNetworkDevices(REGISTRY);
    expect(found.map(f => f.host)).toEqual(['192.168.1.67']);
  });

  it('sorts results by address, numerically', async () => {
    for (const host of ['10.0.0.10', '10.0.0.9', '192.168.1.67']) {
      hosts[host] = { [HR_DEVICE_DESCR]: str('Brother QL-820NWB'), [SERIAL]: str(host) };
    }
    snmpBroadcast.mockResolvedValue([
      { address: '192.168.1.67', value: str('Brother QL-820NWB') },
      { address: '10.0.0.10', value: str('Brother QL-820NWB') },
      { address: '10.0.0.9', value: str('Brother QL-820NWB') },
    ]);
    const { enumerateNetworkDevices } = await load();
    const found = await enumerateNetworkDevices(REGISTRY);
    expect(found.map(f => f.host)).toEqual(['10.0.0.9', '10.0.0.10', '192.168.1.67']);
  });

  it('propagates a broadcast failure', async () => {
    snmpBroadcast.mockRejectedValue(new Error('EACCES'));
    const { enumerateNetworkDevices } = await load();
    await expect(enumerateNetworkDevices(REGISTRY)).rejects.toThrow('EACCES');
  });
});
