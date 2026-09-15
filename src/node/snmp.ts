import { randomInt } from 'node:crypto';
import { createSocket, type RemoteInfo } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { TransportError, TransportTimeoutError } from '@thermal-label/contracts';

/**
 * Options shared by {@link snmpGet} and {@link snmpBroadcast}.
 */
export interface SnmpOptions {
  /** SNMPv1 community string. Default `'public'`. */
  community?: string;
  /** Agent UDP port. Default `161`. */
  port?: number;
  /** Wait per attempt before resending. Default `1000`. */
  timeoutMs?: number;
  /**
   * Resends after a `timeoutMs` with no answer. Total budget per OID is
   * `timeoutMs × (retries + 1)`. Default `1`.
   */
  retries?: number;
}

/**
 * A decoded SNMP value.
 *
 * OCTET STRINGs come back as `string` when every byte is printable ASCII
 * (trailing NULs ignored), else as `octets`. Bit strings such as
 * `hrPrinterDetectedErrorState` can land in either shape depending on
 * which bits are set, so read `raw` for those. INTEGER, Counter32,
 * Gauge32 and TimeTicks all decode to `integer`. Anything else
 * (IpAddress, OBJECT IDENTIFIER, Opaque) is `octets`.
 */
export type SnmpValue =
  | { type: 'string'; value: string; raw: Uint8Array }
  | { type: 'integer'; value: number }
  | { type: 'octets'; raw: Uint8Array }
  | { type: 'noSuchObject' | 'noSuchInstance' | 'null' };

/**
 * Standard MIB-II / Host-Resources-MIB / Printer-MIB objects a network
 * printer answers. Indexes are `.1` (first host device, first input
 * tray) as measured on Brother NC print servers; other vendors may
 * order `hrDeviceTable` differently, which is why `sysDescr` is here.
 */
export const PRINTER_MIB = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  hrDeviceDescr: '1.3.6.1.2.1.25.3.2.1.3.1',
  hrPrinterStatus: '1.3.6.1.2.1.25.3.5.1.1.1',
  hrPrinterDetectedErrorState: '1.3.6.1.2.1.25.3.5.1.2.1',
  prtGeneralSerialNumber: '1.3.6.1.2.1.43.5.1.1.17.1',
  prtInputDimUnit: '1.3.6.1.2.1.43.8.2.1.3.1.1',
  prtInputMediaDimFeedDir: '1.3.6.1.2.1.43.8.2.1.4.1.1',
  prtInputMediaDimXFeedDir: '1.3.6.1.2.1.43.8.2.1.5.1.1',
  prtInputMediaName: '1.3.6.1.2.1.43.8.2.1.12.1.1',
  prtMarkerLifeCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',
} as const;

const DEFAULT_COMMUNITY = 'public';
const DEFAULT_PORT = 161;
const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_RETRIES = 1;
const DEFAULT_WINDOW_MS = 1_000;

// The contracts TransportType union has no UDP member; SNMP is the
// network side channel of the TCP printers, so it reports as 'tcp'.
const TRANSPORT = 'tcp';

// ---------------------------------------------------------------------
// BER / SNMPv1 message codec. Ported from plans/backlog/17-assets/snmp-get.mjs.
// ---------------------------------------------------------------------

const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_NULL = 0x05;
const TAG_OID = 0x06;
const TAG_SEQUENCE = 0x30;
const TAG_COUNTER32 = 0x41;
const TAG_GAUGE32 = 0x42;
const TAG_TIMETICKS = 0x43;
const TAG_COUNTER64 = 0x46;
const TAG_NO_SUCH_OBJECT = 0x80;
const TAG_NO_SUCH_INSTANCE = 0x81;
const TAG_END_OF_MIB_VIEW = 0x82;
const TAG_GET_REQUEST = 0xa0;
const TAG_GET_RESPONSE = 0xa2;

/** One `OID = value` pair inside an SNMP PDU. */
export interface SnmpVarbind {
  oid: string;
  value: SnmpValue;
}

/**
 * The SNMPv1 GET request/response envelope. Exposed so tests and stubs
 * can build well-formed agent responses; drivers never need it.
 */
export interface SnmpMessage {
  community: string;
  pduType: 'get-request' | 'get-response';
  requestId: number;
  errorStatus: number;
  errorIndex: number;
  varbinds: readonly SnmpVarbind[];
}

function encodeLength(n: number): number[] {
  if (n < 0x80) return [n];
  if (n < 0x100) return [0x81, n];
  return [0x82, n >> 8, n & 0xff];
}

function tlv(tag: number, body: readonly number[]): number[] {
  return [tag, ...encodeLength(body.length), ...body];
}

// Minimal two's-complement INTEGER (request ids, error fields, values).
function encodeInteger(n: number): number[] {
  let v = BigInt(Math.trunc(n));
  const bytes: number[] = [];
  for (;;) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
    const top = bytes[0] ?? 0;
    if ((v === 0n && (top & 0x80) === 0) || (v === -1n && (top & 0x80) !== 0)) break;
  }
  return tlv(TAG_INTEGER, bytes);
}

function encodeOid(oid: string): number[] {
  const parts = oid.split('.').map(Number);
  if (parts.length < 2 || parts.some(p => !Number.isInteger(p) || p < 0)) {
    throw new TypeError(`Invalid OID "${oid}"`);
  }
  const [first = 0, second = 0, ...rest] = parts;
  const out = [first * 40 + second];
  for (const n of rest) {
    const stack: number[] = [];
    let v = n;
    do {
      stack.unshift((v & 0x7f) | (stack.length > 0 ? 0x80 : 0));
      v = Math.floor(v / 128);
    } while (v > 0);
    out.push(...stack);
  }
  return tlv(TAG_OID, out);
}

function encodeValue(value: SnmpValue): number[] {
  switch (value.type) {
    case 'string':
      return tlv(TAG_OCTET_STRING, [...Buffer.from(value.value, 'latin1')]);
    case 'octets':
      return tlv(TAG_OCTET_STRING, [...value.raw]);
    case 'integer':
      return encodeInteger(value.value);
    case 'null':
      return [TAG_NULL, 0];
    case 'noSuchObject':
      return [TAG_NO_SUCH_OBJECT, 0];
    case 'noSuchInstance':
      return [TAG_NO_SUCH_INSTANCE, 0];
  }
}

/** Encode an SNMPv1 message. See {@link SnmpMessage}. */
export function encodeSnmpMessage(message: SnmpMessage): Uint8Array {
  const varbinds = message.varbinds.flatMap(vb =>
    tlv(TAG_SEQUENCE, [...encodeOid(vb.oid), ...encodeValue(vb.value)]),
  );
  const pdu = tlv(message.pduType === 'get-request' ? TAG_GET_REQUEST : TAG_GET_RESPONSE, [
    ...encodeInteger(message.requestId),
    ...encodeInteger(message.errorStatus),
    ...encodeInteger(message.errorIndex),
    ...tlv(TAG_SEQUENCE, varbinds),
  ]);
  return Uint8Array.from(
    tlv(TAG_SEQUENCE, [
      ...encodeInteger(0), // version 1
      ...tlv(TAG_OCTET_STRING, [...Buffer.from(message.community, 'latin1')]),
      ...pdu,
    ]),
  );
}

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function readTlv(buf: Uint8Array, offset: number): Tlv {
  const tag = buf[offset];
  let length = buf[offset + 1];
  if (tag === undefined || length === undefined) throw new RangeError('truncated TLV');
  let o = offset + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++) {
      const b = buf[o++];
      if (b === undefined) throw new RangeError('truncated TLV length');
      length = length * 256 + b;
    }
  }
  if (o + length > buf.length) throw new RangeError('truncated TLV body');
  return { tag, start: o, end: o + length };
}

function decodeInteger(body: Uint8Array, signed: boolean): number {
  let v = 0;
  for (const b of body) v = v * 256 + b;
  if (signed && ((body[0] ?? 0) & 0x80) !== 0) v -= 256 ** body.length;
  return v;
}

function decodeOid(body: Uint8Array): string {
  const first = body[0] ?? 0;
  const parts = [Math.floor(first / 40), first % 40];
  let v = 0;
  for (let i = 1; i < body.length; i++) {
    const b = body[i] ?? 0;
    v = v * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join('.');
}

function decodeValue(tag: number, body: Uint8Array): SnmpValue {
  switch (tag) {
    case TAG_OCTET_STRING: {
      // Plain Uint8Array copy: `body` is a view into the datagram Buffer.
      const raw = Uint8Array.from(body);
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      // All-NUL (a cleared bit string) is octets; genuinely empty is ''.
      const printable =
        end > 0 ? raw.subarray(0, end).every(b => b >= 0x20 && b <= 0x7e) : raw.length === 0;
      return printable
        ? { type: 'string', value: Buffer.from(raw.subarray(0, end)).toString('latin1'), raw }
        : { type: 'octets', raw };
    }
    case TAG_INTEGER:
      return { type: 'integer', value: decodeInteger(body, true) };
    case TAG_COUNTER32:
    case TAG_GAUGE32:
    case TAG_TIMETICKS:
    case TAG_COUNTER64:
      return { type: 'integer', value: decodeInteger(body, false) };
    case TAG_NULL:
      return { type: 'null' };
    case TAG_NO_SUCH_OBJECT:
      return { type: 'noSuchObject' };
    case TAG_NO_SUCH_INSTANCE:
    case TAG_END_OF_MIB_VIEW:
      return { type: 'noSuchInstance' };
    default:
      return { type: 'octets', raw: Uint8Array.from(body) };
  }
}

/**
 * Decode an SNMPv1 GET request or response. Throws `RangeError` on a
 * truncated or non-SNMP datagram; callers drop those.
 */
export function decodeSnmpMessage(buf: Uint8Array): SnmpMessage {
  const message = readTlv(buf, 0);
  if (message.tag !== TAG_SEQUENCE) throw new RangeError('not an SNMP message');
  const version = readTlv(buf, message.start);
  const community = readTlv(buf, version.end);
  const pdu = readTlv(buf, community.end);
  if (pdu.tag !== TAG_GET_REQUEST && pdu.tag !== TAG_GET_RESPONSE) {
    throw new RangeError(`unsupported PDU 0x${pdu.tag.toString(16)}`);
  }
  const requestId = readTlv(buf, pdu.start);
  const errorStatus = readTlv(buf, requestId.end);
  const errorIndex = readTlv(buf, errorStatus.end);
  const list = readTlv(buf, errorIndex.end);
  const varbinds: SnmpVarbind[] = [];
  let o = list.start;
  while (o < list.end) {
    const vb = readTlv(buf, o);
    const oid = readTlv(buf, vb.start);
    const value = readTlv(buf, oid.end);
    varbinds.push({
      oid: decodeOid(buf.subarray(oid.start, oid.end)),
      value: decodeValue(value.tag, buf.subarray(value.start, value.end)),
    });
    o = vb.end;
  }
  return {
    community: Buffer.from(buf.subarray(community.start, community.end)).toString('latin1'),
    pduType: pdu.tag === TAG_GET_REQUEST ? 'get-request' : 'get-response',
    requestId: decodeInteger(buf.subarray(requestId.start, requestId.end), true),
    errorStatus: decodeInteger(buf.subarray(errorStatus.start, errorStatus.end), true),
    errorIndex: decodeInteger(buf.subarray(errorIndex.start, errorIndex.end), true),
    varbinds,
  };
}

// An SNMPv1 agent reports a missing object as errorStatus noSuchName (2)
// for the whole PDU; v2c-style agents answer a per-varbind exception.
// Both collapse to `noSuchObject` so callers see one shape.
function firstValue(message: SnmpMessage): SnmpValue {
  if (message.errorStatus !== 0) return { type: 'noSuchObject' };
  return message.varbinds[0]?.value ?? { type: 'null' };
}

// Request ids are random so a LAN host cannot forge an answer by
// guessing the ephemeral port alone. 31-bit keeps them inside SNMP's
// INTEGER range; the batch needs `count` consecutive ids.
function randomRequestId(count: number): number {
  return randomInt(1, 2 ** 31 - count);
}

function isResponse(message: SnmpMessage, rinfo: RemoteInfo, port: number): boolean {
  return message.pduType === 'get-response' && rinfo.port === port;
}

function getRequest(requestId: number, oid: string, community: string): Uint8Array {
  return encodeSnmpMessage({
    community,
    pduType: 'get-request',
    requestId,
    errorStatus: 0,
    errorIndex: 0,
    varbinds: [{ oid, value: { type: 'null' } }],
  });
}

// ---------------------------------------------------------------------
// Unicast GET
// ---------------------------------------------------------------------

interface PendingGet {
  oid: string;
  packet: Uint8Array;
  timer: NodeJS.Timeout | undefined;
  resendsLeft: number;
}

/**
 * SNMPv1 GET of one or more OIDs from `host`.
 *
 * One request per OID, all in flight on one socket, matched back by
 * request id: a v1 agent fails a whole multi-varbind PDU when any one
 * OID is absent, per-OID requests keep the others alive. Only a
 * GetResponse from the target's address and port with a matching
 * (random) request id is taken; anything else on the socket is dropped.
 * Rejects with `TransportTimeoutError` when *no* OID was answered
 * within the budget (host down, SNMP disabled, wrong community) and
 * with `TransportError` on a socket failure or when `host` does not
 * resolve. An OID that individually got no answer while others did is
 * simply absent from the result.
 */
export async function snmpGet(
  host: string,
  oids: readonly string[],
  opts: SnmpOptions = {},
): Promise<Record<string, SnmpValue>> {
  const community = opts.community ?? DEFAULT_COMMUNITY;
  const port = opts.port ?? DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  if (oids.length === 0) return {};

  let address: string;
  try {
    address = (await lookup(host, { family: 4 })).address;
  } catch (err) {
    throw new TransportError(
      `SNMP host ${host} does not resolve: ${err instanceof Error ? err.message : String(err)}`,
      TRANSPORT,
    );
  }

  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4');
    const result: Record<string, SnmpValue> = {};
    const pending = new Map<number, PendingGet>();
    let answered = 0;
    let settled = false;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      try {
        sock.close();
      } catch {
        /* already closed by the error path */
      }
      if (err) reject(err);
      else resolve(result);
    };

    const maybeDone = (): void => {
      if (pending.size > 0) return;
      if (answered === 0) {
        finish(new TransportTimeoutError(TRANSPORT, timeoutMs * (retries + 1)));
      } else {
        finish();
      }
    };

    const sendFailed = (err: Error): void => {
      finish(new TransportError(`SNMP send to ${host} failed: ${err.message}`, TRANSPORT));
    };

    const send = (entry: PendingGet): void => {
      try {
        sock.send(entry.packet, port, address, err => {
          if (err) sendFailed(err);
        });
      } catch (err) {
        sendFailed(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const arm = (id: number, entry: PendingGet): void => {
      entry.timer = setTimeout(() => {
        if (entry.resendsLeft > 0) {
          entry.resendsLeft--;
          send(entry);
          arm(id, entry);
        } else {
          pending.delete(id);
          maybeDone();
        }
      }, timeoutMs);
    };

    sock.on('error', err => {
      finish(new TransportError(`SNMP socket error: ${err.message}`, TRANSPORT));
    });

    sock.on('message', (msg, rinfo) => {
      if (rinfo.address !== address) return;
      let decoded: SnmpMessage;
      try {
        decoded = decodeSnmpMessage(msg);
      } catch {
        return;
      }
      if (!isResponse(decoded, rinfo, port)) return;
      const entry = pending.get(decoded.requestId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(decoded.requestId);
      answered++;
      result[entry.oid] = firstValue(decoded);
      maybeDone();
    });

    const firstId = randomRequestId(oids.length);
    for (const [i, oid] of oids.entries()) {
      const id = firstId + i;
      const entry: PendingGet = {
        oid,
        packet: getRequest(id, oid, community),
        timer: undefined,
        resendsLeft: retries,
      };
      pending.set(id, entry);
      send(entry);
      arm(id, entry);
    }
  });
}

// ---------------------------------------------------------------------
// Subnet broadcast
// ---------------------------------------------------------------------

function ipv4ToInt(address: string): number | undefined {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    return undefined;
  }
  return parts.reduce((acc, p) => acc * 256 + p, 0);
}

function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map(shift => (n >>> shift) & 0xff).join('.');
}

// Directed broadcast of every non-internal IPv4 interface, deduped: two
// interfaces on one LAN (a wired + wireless bench host) yield one target.
// /32 interfaces (VPN tunnels) have no broadcast domain and are skipped.
function broadcastAddresses(): string[] {
  const out = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      const address = ipv4ToInt(entry.address);
      const mask = ipv4ToInt(entry.netmask);
      if (address === undefined || mask === undefined || mask === 0xffffffff) continue;
      out.add(intToIpv4(((address & mask) | ~mask) >>> 0));
    }
  }
  return [...out];
}

/**
 * SNMPv1 GET of one OID to the directed broadcast address of every
 * non-internal IPv4 interface. Collects answers for `windowMs` (default
 * 1000) and resolves with one entry per responder address, first answer
 * wins. `retries` resends of the broadcast are spread evenly over the
 * window (WiFi drops broadcast frames; dedupe makes the resend free).
 *
 * Best-effort by design: a send that fails on one interface is ignored,
 * and a host with no broadcast-capable interface resolves to `[]`.
 * Responders that do not carry the OID answer `noSuchObject`; filter on
 * `value.type` before matching.
 */
export function snmpBroadcast(
  oid: string,
  opts: SnmpOptions & { windowMs?: number } = {},
): Promise<{ address: string; value: SnmpValue }[]> {
  const community = opts.community ?? DEFAULT_COMMUNITY;
  const port = opts.port ?? DEFAULT_PORT;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const targets = broadcastAddresses();
  if (targets.length === 0) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4');
    const seen = new Map<string, SnmpValue>();
    const timers: NodeJS.Timeout[] = [];
    let settled = false;
    const requestId = randomRequestId(1);
    const packet = getRequest(requestId, oid, community);

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      try {
        sock.close();
      } catch {
        /* already closed by the error path */
      }
      if (err) reject(err);
      else resolve([...seen].map(([address, value]) => ({ address, value })));
    };

    const sendAll = (): void => {
      for (const target of targets) {
        try {
          sock.send(packet, port, target, () => {
            /* best-effort per interface */
          });
        } catch {
          /* best-effort per interface */
        }
      }
    };

    sock.on('error', err => {
      finish(new TransportError(`SNMP broadcast socket error: ${err.message}`, TRANSPORT));
    });

    sock.on('message', (msg, rinfo) => {
      let decoded: SnmpMessage;
      try {
        decoded = decodeSnmpMessage(msg);
      } catch {
        return;
      }
      if (!isResponse(decoded, rinfo, port) || decoded.requestId !== requestId) return;
      if (seen.has(rinfo.address)) return;
      seen.set(rinfo.address, firstValue(decoded));
    });

    sock.bind(() => {
      try {
        sock.setBroadcast(true);
      } catch (err) {
        finish(
          new TransportError(
            `SNMP broadcast not permitted: ${err instanceof Error ? err.message : String(err)}`,
            TRANSPORT,
          ),
        );
        return;
      }
      sendAll();
      for (let i = 1; i <= retries; i++) {
        timers.push(setTimeout(sendAll, Math.floor((windowMs * i) / (retries + 1))));
      }
      timers.push(
        setTimeout(() => {
          finish();
        }, windowMs),
      );
    });
  });
}
