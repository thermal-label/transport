import { afterEach, describe, expect, it } from 'vitest';
import { createSocket, type Socket } from 'node:dgram';
import { TransportError, TransportTimeoutError } from '@thermal-label/contracts';
import {
  decodeSnmpMessage,
  encodeSnmpMessage,
  PRINTER_MIB,
  snmpGet,
  type SnmpMessage,
  type SnmpValue,
} from '../node/snmp.js';

// Bench values from plan 17 §Context (QL-820NWBc, DK-11201 / DK-22251).
const MODEL = 'Brother QL-820NWB';
const SERIAL = 'M5G679125';
const MEDIA_DIE_CUT = '29mm x 90mm / 1.1" x 3.5"';
const MEDIA_CONTINUOUS = '62mm / 2.4"';

const str = (value: string): SnmpValue => ({
  type: 'string',
  value,
  raw: Uint8Array.from(Buffer.from(value, 'latin1')),
});
const int = (value: number): SnmpValue => ({ type: 'integer', value });
const octets = (...bytes: number[]): SnmpValue => ({ type: 'octets', raw: Uint8Array.from(bytes) });

const BENCH_TABLE: Record<string, SnmpValue> = {
  [PRINTER_MIB.hrDeviceDescr]: str(MODEL),
  [PRINTER_MIB.prtGeneralSerialNumber]: str(SERIAL),
  [PRINTER_MIB.hrPrinterStatus]: int(3),
  [PRINTER_MIB.hrPrinterDetectedErrorState]: octets(0x00),
  [PRINTER_MIB.prtInputMediaName]: str(MEDIA_DIE_CUT),
  [PRINTER_MIB.prtInputMediaDimFeedDir]: int(-1),
  [PRINTER_MIB.prtMarkerLifeCount]: int(1234),
};

function message(partial: Partial<SnmpMessage> & Pick<SnmpMessage, 'varbinds'>): SnmpMessage {
  return {
    community: 'public',
    pduType: 'get-response',
    requestId: 1,
    errorStatus: 0,
    errorIndex: 0,
    ...partial,
  };
}

function roundTrip(value: SnmpValue, oid = PRINTER_MIB.hrDeviceDescr): SnmpValue {
  const decoded = decodeSnmpMessage(encodeSnmpMessage(message({ varbinds: [{ oid, value }] })));
  const first = decoded.varbinds[0];
  if (!first) throw new Error('no varbind');
  return first.value;
}

// Re-tag the value TLV (always last in the message) so the decoder sees
// application tags the encoder never emits (Counter32, IpAddress, …).
function retagged(value: SnmpValue, bodyLength: number, tag: number): SnmpValue {
  const patched = Uint8Array.from(
    encodeSnmpMessage(message({ varbinds: [{ oid: '1.3.6.1', value }] })),
  );
  patched[patched.length - bodyLength - 2] = tag;
  const first = decodeSnmpMessage(patched).varbinds[0];
  if (!first) throw new Error('no varbind');
  return first.value;
}

describe('SNMP BER codec', () => {
  it('round-trips printable OCTET STRINGs as string with raw bytes', () => {
    for (const s of [MODEL, SERIAL, MEDIA_DIE_CUT, MEDIA_CONTINUOUS, '']) {
      const v = roundTrip(str(s));
      expect(v).toEqual(str(s));
    }
  });

  it('round-trips INTEGERs across the two’s-complement edges', () => {
    for (const n of [0, 1, 127, 128, 255, 256, -1, -128, -129, 65535, 2 ** 31 - 1, -(2 ** 31)]) {
      expect(roundTrip(int(n))).toEqual(int(n));
    }
  });

  it('decodes error-state bit strings of 0, 1 and 2 octets, raw intact', () => {
    // 0 octets: an empty string, empty raw
    expect(roundTrip(octets())).toEqual({ type: 'string', value: '', raw: new Uint8Array(0) });
    // 1 octet 0x00 (the bench value, no error bits): octets, not ''
    expect(roundTrip(octets(0x00))).toEqual(octets(0x00));
    expect(roundTrip(octets(0x00, 0x00))).toEqual(octets(0x00, 0x00));
    // 2 octets, bit 1 (noPaper) set: 0x40 is '@', printable → string, raw still readable
    const v = roundTrip(octets(0x40, 0x00));
    expect(v.type).toBe('string');
    expect(v.type === 'string' && [...v.raw]).toEqual([0x40, 0x00]);
    // 2 octets with a high bit: octets
    expect(roundTrip(octets(0x80, 0x04))).toEqual(octets(0x80, 0x04));
  });

  it('trims trailing NUL padding from strings but keeps raw', () => {
    const v = roundTrip(octets(0x51, 0x4c, 0x00, 0x00)); // "QL\0\0"
    expect(v).toEqual({ type: 'string', value: 'QL', raw: Uint8Array.from([0x51, 0x4c, 0, 0]) });
  });

  it('round-trips null, noSuchObject and noSuchInstance', () => {
    for (const type of ['null', 'noSuchObject', 'noSuchInstance'] as const) {
      expect(roundTrip({ type })).toEqual({ type });
    }
  });

  it('round-trips multi-byte OID arcs and the Brother private subtree', () => {
    const oid = '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.1.0';
    const decoded = decodeSnmpMessage(
      encodeSnmpMessage(message({ varbinds: [{ oid, value: { type: 'null' } }] })),
    );
    expect(decoded.varbinds[0]?.oid).toBe(oid);
  });

  it('uses long-form lengths for bodies ≥ 128 and ≥ 256 bytes', () => {
    for (const n of [127, 128, 200, 255, 256, 300]) {
      const s = 'x'.repeat(n);
      expect(roundTrip(str(s))).toEqual(str(s));
    }
  });

  it('encodes request ids ≥ 128 without sign flips', () => {
    const decoded = decodeSnmpMessage(encodeSnmpMessage(message({ requestId: 200, varbinds: [] })));
    expect(decoded.requestId).toBe(200);
    expect(decoded.varbinds).toEqual([]);
  });

  it('keeps community, pduType and error fields', () => {
    const decoded = decodeSnmpMessage(
      encodeSnmpMessage(
        message({
          community: 'private',
          pduType: 'get-request',
          requestId: 7,
          errorStatus: 2,
          errorIndex: 1,
          varbinds: [{ oid: '1.3.6.1', value: { type: 'null' } }],
        }),
      ),
    );
    expect(decoded).toMatchObject({
      community: 'private',
      pduType: 'get-request',
      requestId: 7,
      errorStatus: 2,
      errorIndex: 1,
    });
  });

  it('decodes Counter32 / Gauge32 / TimeTicks / Counter64 as integers', () => {
    for (const tag of [0x41, 0x42, 0x43, 0x46]) {
      expect(retagged(int(1234), 2, tag)).toEqual(int(1234));
    }
    // unsigned: 0xff as Counter32 is 255, not -1
    expect(retagged(int(-1), 1, 0x41)).toEqual(int(255));
  });

  it('maps endOfMibView to noSuchInstance and unknown tags to octets', () => {
    expect(retagged(octets(), 0, 0x82)).toEqual({ type: 'noSuchInstance' });
    expect(retagged(octets(192, 168, 1, 67), 4, 0x40)).toEqual(octets(192, 168, 1, 67));
  });

  it('rejects truncated, non-SNMP and non-GET datagrams', () => {
    const good = encodeSnmpMessage(message({ varbinds: [{ oid: '1.3.6.1', value: str('a') }] }));
    expect(() => decodeSnmpMessage(good.subarray(0, good.length - 1))).toThrow(RangeError);
    expect(() => decodeSnmpMessage(Uint8Array.from([0x04, 0x01, 0x41]))).toThrow(RangeError);
    expect(() => decodeSnmpMessage(new Uint8Array(0))).toThrow(RangeError);
    const getNext = Uint8Array.from(good);
    getNext[getNext.indexOf(0xa2)] = 0xa1;
    expect(() => decodeSnmpMessage(getNext)).toThrow(/unsupported PDU/);
    // long-form length that claims more than the buffer holds
    expect(() => decodeSnmpMessage(Uint8Array.from([0x30, 0x82, 0x01]))).toThrow(RangeError);
  });

  it('refuses to encode a malformed OID', () => {
    expect(() =>
      encodeSnmpMessage(message({ varbinds: [{ oid: '1.3.x', value: { type: 'null' } }] })),
    ).toThrow(TypeError);
    expect(() =>
      encodeSnmpMessage(message({ varbinds: [{ oid: '1', value: { type: 'null' } }] })),
    ).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------
// Local SNMPv1 agent stub — the only socket any test in this package opens.
// ---------------------------------------------------------------------

interface AgentOptions {
  table?: Record<string, SnmpValue>;
  /** Answer a missing OID with errorStatus=2 (strict v1) instead of a v2c exception. */
  strictV1?: boolean;
  /** Drop this many requests before answering. */
  dropFirst?: number;
  /** Never answer these OIDs. */
  dropOids?: readonly string[];
  /** Answer with a request id nobody asked for. */
  mangleId?: boolean;
  /** Send a non-SNMP datagram before the real answer. */
  garbageFirst?: boolean;
  /** Send a decoy answer from a second socket (wrong source port) before the real one. */
  decoyFromOtherPort?: boolean;
  /** Echo the request back (GetRequest PDU, same id) before the real answer. */
  echoRequestFirst?: boolean;
}

interface Agent {
  port: number;
  requests: SnmpMessage[];
  close(): Promise<void>;
}

const agents: Socket[] = [];

async function startAgent(opts: AgentOptions = {}): Promise<Agent> {
  const sock = createSocket('udp4');
  agents.push(sock);
  const requests: SnmpMessage[] = [];
  let drops = opts.dropFirst ?? 0;
  const table = opts.table ?? BENCH_TABLE;
  sock.on('message', (msg, rinfo) => {
    const req = decodeSnmpMessage(msg);
    requests.push(req);
    const vb = req.varbinds[0];
    if (!vb) return;
    if (drops > 0) {
      drops--;
      return;
    }
    if (opts.dropOids?.includes(vb.oid)) return;
    if (opts.garbageFirst) sock.send(Buffer.from([0x01, 0x02, 0x03]), rinfo.port, rinfo.address);
    if (opts.echoRequestFirst) sock.send(msg, rinfo.port, rinfo.address);
    if (opts.decoyFromOtherPort) {
      const decoy = createSocket('udp4');
      agents.push(decoy);
      decoy.send(
        encodeSnmpMessage(
          message({
            requestId: req.requestId,
            varbinds: [{ oid: vb.oid, value: str('decoy') }],
          }),
        ),
        rinfo.port,
        rinfo.address,
      );
    }
    const value = table[vb.oid];
    const response: SnmpMessage =
      value === undefined && opts.strictV1
        ? message({
            requestId: req.requestId,
            errorStatus: 2,
            errorIndex: 1,
            varbinds: req.varbinds,
          })
        : message({
            requestId: opts.mangleId ? req.requestId + 1000 : req.requestId,
            varbinds: [{ oid: vb.oid, value: value ?? { type: 'noSuchObject' } }],
          });
    sock.send(encodeSnmpMessage(response), rinfo.port, rinfo.address);
  });
  await new Promise<void>(resolve => {
    sock.bind(0, '127.0.0.1', resolve);
  });
  return {
    port: sock.address().port,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        sock.close(resolve);
      }),
  };
}

afterEach(() => {
  for (const s of agents.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
});

const FAST = { timeoutMs: 60, retries: 0 };

describe('snmpGet', () => {
  it('fetches the bench OID set from a v1 agent in one call', async () => {
    const agent = await startAgent();
    const oids = Object.keys(BENCH_TABLE);
    const result = await snmpGet('127.0.0.1', oids, { port: agent.port, ...FAST });
    expect(result).toEqual(BENCH_TABLE);
    // one request per OID, consecutive request ids from a random base, community forwarded
    const ids = agent.requests.map(r => r.requestId).sort((a, b) => a - b);
    expect(ids).toEqual(oids.map((_, i) => (ids[0] ?? 0) + i));
    expect(agent.requests.every(r => r.community === 'public')).toBe(true);
  });

  it('resolves {} for an empty OID list without opening a socket', async () => {
    await expect(snmpGet('127.0.0.1', [], { port: 1 })).resolves.toEqual({});
  });

  it('forwards a custom community', async () => {
    const agent = await startAgent();
    await snmpGet('127.0.0.1', [PRINTER_MIB.sysDescr], {
      port: agent.port,
      community: 'bench',
      ...FAST,
    });
    expect(agent.requests[0]?.community).toBe('bench');
  });

  it('reports a missing OID as noSuchObject on a strict v1 agent, keeping the rest', async () => {
    const agent = await startAgent({ strictV1: true });
    const result = await snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr, PRINTER_MIB.sysDescr], {
      port: agent.port,
      ...FAST,
    });
    expect(result[PRINTER_MIB.hrDeviceDescr]).toEqual(str(MODEL));
    expect(result[PRINTER_MIB.sysDescr]).toEqual({ type: 'noSuchObject' });
  });

  it('passes a v2c-style noSuchObject exception through', async () => {
    const agent = await startAgent();
    const result = await snmpGet('127.0.0.1', [PRINTER_MIB.sysDescr], {
      port: agent.port,
      ...FAST,
    });
    expect(result[PRINTER_MIB.sysDescr]).toEqual({ type: 'noSuchObject' });
  });

  it('resends after a silent timeout and accepts the answer to the resend', async () => {
    const agent = await startAgent({ dropFirst: 1 });
    const result = await snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr], {
      port: agent.port,
      timeoutMs: 40,
      retries: 1,
    });
    expect(result[PRINTER_MIB.hrDeviceDescr]).toEqual(str(MODEL));
    expect(agent.requests).toHaveLength(2);
    expect(agent.requests[0]?.requestId).toBe(agent.requests[1]?.requestId);
  });

  it('rejects with TransportTimeoutError when nothing answers within the budget', async () => {
    const agent = await startAgent({ dropFirst: 99 });
    const started = Date.now();
    await expect(
      snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr], {
        port: agent.port,
        timeoutMs: 30,
        retries: 2,
      }),
    ).rejects.toBeInstanceOf(TransportTimeoutError);
    // three attempts × 30 ms
    expect(Date.now() - started).toBeGreaterThanOrEqual(85);
    expect(agent.requests).toHaveLength(3);
  });

  it('omits an OID that never answered when the others did', async () => {
    const agent = await startAgent({ dropOids: [PRINTER_MIB.sysDescr] });
    const result = await snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr, PRINTER_MIB.sysDescr], {
      port: agent.port,
      ...FAST,
    });
    expect(Object.keys(result)).toEqual([PRINTER_MIB.hrDeviceDescr]);
  });

  it('ignores answers carrying an unknown request id', async () => {
    const agent = await startAgent({ mangleId: true });
    await expect(
      snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr], { port: agent.port, ...FAST }),
    ).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('ignores an answer from the wrong source port and takes the real one', async () => {
    const agent = await startAgent({ decoyFromOtherPort: true });
    const result = await snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr], {
      port: agent.port,
      ...FAST,
    });
    expect(result[PRINTER_MIB.hrDeviceDescr]).toEqual(str(MODEL));
  });

  it('ignores an echoed GetRequest and takes the GetResponse', async () => {
    const agent = await startAgent({ echoRequestFirst: true });
    const result = await snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr], {
      port: agent.port,
      ...FAST,
    });
    expect(result[PRINTER_MIB.hrDeviceDescr]).toEqual(str(MODEL));
  });

  it('uses random 31-bit request ids, consecutive within one call', async () => {
    const agent = await startAgent();
    await snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr, PRINTER_MIB.sysDescr], {
      port: agent.port,
      ...FAST,
    });
    const ids = agent.requests.map(r => r.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeGreaterThan(0);
    expect(ids[1]).toBe((ids[0] ?? 0) + 1);
    expect(Math.max(...ids)).toBeLessThan(2 ** 31);
    const again = await startAgent();
    await snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr], { port: again.port, ...FAST });
    expect(again.requests[0]?.requestId).not.toBe(ids[0]);
  });

  it('resolves a hostname once and rejects with TransportError when it does not', async () => {
    const agent = await startAgent();
    const result = await snmpGet('localhost', [PRINTER_MIB.hrDeviceDescr], {
      port: agent.port,
      ...FAST,
    });
    expect(result[PRINTER_MIB.hrDeviceDescr]).toEqual(str(MODEL));
    await expect(
      snmpGet('no-such-host.invalid', [PRINTER_MIB.hrDeviceDescr], FAST),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it('ignores a non-SNMP datagram and still takes the real answer', async () => {
    const agent = await startAgent({ garbageFirst: true });
    const result = await snmpGet('127.0.0.1', [PRINTER_MIB.hrDeviceDescr], {
      port: agent.port,
      ...FAST,
    });
    expect(result[PRINTER_MIB.hrDeviceDescr]).toEqual(str(MODEL));
  });

  it('rejects with TransportError when the datagram cannot be sent', async () => {
    // IPv6 literal on the udp4 socket → EINVAL from the send callback
    await expect(snmpGet('::1', [PRINTER_MIB.sysDescr], FAST)).rejects.toBeInstanceOf(
      TransportError,
    );
    // out-of-range port → synchronous throw from dgram, same error class
    await expect(
      snmpGet('127.0.0.1', [PRINTER_MIB.sysDescr], { port: 70_000, ...FAST }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});
