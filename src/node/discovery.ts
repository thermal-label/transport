import type { DeviceEntry } from '@thermal-label/contracts';
import type { Device } from 'usb';
import { matchDevice, matchModelName } from '../discovery.js';
import { PRINTER_MIB, snmpBroadcast, snmpGet, type SnmpOptions, type SnmpValue } from './snmp.js';

const SERIAL_READ_TIMEOUT_MS = 1_000;

export interface EnumeratedUsbDevice {
  descriptor: DeviceEntry;
  serialNumber?: string;
  /** Normalized `${busNumber}:${deviceAddress}`. Display-only. */
  connectionId: string;
}

/**
 * Enumerate connected USB devices that match one of the given registries.
 *
 * Owns the `usb` native addon (lazy-imported) so drivers no longer reach
 * around transport into `usb` to list devices — see DECISIONS.md D1. The
 * registry match, the `iSerialNumber` guard, the open/read/close lifecycle,
 * and `connectionId` normalization all live here once.
 *
 * Resilient by contract: a matched device we cannot open or whose serial we
 * cannot read (busy, permission, unplugged mid-scan, hung descriptor read) is
 * still returned, just without a `serialNumber`. One bad device never aborts
 * the scan.
 */
export async function enumerateUsbDevices(
  registries: readonly DeviceEntry[],
): Promise<EnumeratedUsbDevice[]> {
  const { getDeviceList } = await import('usb');
  const out: EnumeratedUsbDevice[] = [];
  for (const device of getDeviceList()) {
    const desc = device.deviceDescriptor;
    const descriptor = matchDevice(desc.idVendor, desc.idProduct, registries);
    if (!descriptor) continue;
    const serialNumber = await tryReadSerial(device, desc.iSerialNumber);
    out.push({
      descriptor,
      ...(serialNumber === undefined ? {} : { serialNumber }),
      connectionId: `${String(device.busNumber)}:${String(device.deviceAddress)}`,
    });
  }
  return out;
}

async function tryReadSerial(device: Device, idx: number | undefined): Promise<string | undefined> {
  if (!idx) return undefined;
  try {
    device.open();
  } catch {
    return undefined;
  }
  try {
    return await readSerial(device, idx);
  } finally {
    try {
      device.close();
    } catch {
      /* best-effort */
    }
  }
}

function readSerial(device: Device, idx: number): Promise<string | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish();
    }, SERIAL_READ_TIMEOUT_MS);
    device.getStringDescriptor(idx, (err, value) => {
      finish(err ? undefined : value);
    });
  });
}

export interface EnumeratedNetworkDevice {
  descriptor: DeviceEntry;
  host: string;
  /** `descriptor.transports.tcp.port`. */
  port: number;
  /** `prtGeneralSerialNumber`, when the agent answers it. */
  serialNumber?: string;
  /** `hrDeviceDescr` (or `sysDescr`) as reported. */
  modelName: string;
  /** `${host}:${port}`. Display-only. */
  connectionId: string;
}

interface TcpEntry extends DeviceEntry {
  transports: DeviceEntry['transports'] & { tcp: NonNullable<DeviceEntry['transports']['tcp']> };
}

function tcpCapable(registries: readonly DeviceEntry[]): TcpEntry[] {
  return registries.filter((d): d is TcpEntry => d.transports.tcp !== undefined);
}

function asString(value: SnmpValue | undefined): string | undefined {
  return value?.type === 'string' && value.value.length > 0 ? value.value : undefined;
}

function networkDevice(
  descriptor: TcpEntry,
  host: string,
  modelName: string,
  serialNumber: string | undefined,
): EnumeratedNetworkDevice {
  const port = descriptor.transports.tcp.port;
  return {
    descriptor,
    host,
    port,
    ...(serialNumber === undefined ? {} : { serialNumber }),
    modelName,
    connectionId: `${host}:${String(port)}`,
  };
}

function matchTcp(modelName: string, candidates: readonly TcpEntry[]): TcpEntry | undefined {
  const match = matchModelName(modelName, candidates);
  return match === undefined ? undefined : candidates.find(c => c === match);
}

/**
 * Ask one host over SNMP what it is and match the answer against the
 * TCP-capable entries of the given registries.
 *
 * One GET fetches `hrDeviceDescr.1`, `sysDescr.0` and the serial.
 * `hrDeviceDescr.1` is matched first; `sysDescr.0` whenever that is
 * absent *or* matches nothing (other vendors list an interface, not the
 * printer, at `hrDeviceIndex` 1). Resolves `undefined` when the host
 * answered but is not in these registries ("not mine"); rejects
 * (`TransportTimeoutError` / `TransportError`) when it could not be
 * asked at all (host down, SNMP disabled, wrong community), so drivers
 * can tell the two apart. Never opens a TCP connection.
 */
export async function identifyNetworkDevice(
  host: string,
  registries: readonly DeviceEntry[],
  opts: SnmpOptions = {},
): Promise<EnumeratedNetworkDevice | undefined> {
  const answers = await snmpGet(
    host,
    [PRINTER_MIB.hrDeviceDescr, PRINTER_MIB.sysDescr, PRINTER_MIB.prtGeneralSerialNumber],
    opts,
  );
  const candidates = tcpCapable(registries);
  for (const oid of [PRINTER_MIB.hrDeviceDescr, PRINTER_MIB.sysDescr]) {
    const modelName = asString(answers[oid]);
    if (modelName === undefined) continue;
    const descriptor = matchTcp(modelName, candidates);
    if (descriptor === undefined) continue;
    return networkDevice(
      descriptor,
      host,
      modelName,
      asString(answers[PRINTER_MIB.prtGeneralSerialNumber]),
    );
  }
  return undefined;
}

async function fetchSerial(host: string, opts: SnmpOptions): Promise<string | undefined> {
  try {
    const answers = await snmpGet(host, [PRINTER_MIB.prtGeneralSerialNumber], opts);
    return asString(answers[PRINTER_MIB.prtGeneralSerialNumber]);
  } catch {
    return undefined;
  }
}

/**
 * Find network printers on the local subnets: one SNMP broadcast of
 * `hrDeviceDescr.1`, every responder matched against the TCP-capable
 * entries of the given registries, then one unicast for the serial.
 * Responders whose `hrDeviceDescr.1` is absent or matches nothing go
 * through {@link identifyNetworkDevice} for the `sysDescr` fallback.
 *
 * Best-effort like {@link enumerateUsbDevices}: a responder that stops
 * answering mid-scan is dropped (or listed without a serial), never
 * aborts the scan. Registries with no TCP-capable entry send nothing.
 * Results are sorted by address so repeated scans list in one order.
 */
export async function enumerateNetworkDevices(
  registries: readonly DeviceEntry[],
  opts: SnmpOptions & { windowMs?: number } = {},
): Promise<EnumeratedNetworkDevice[]> {
  const candidates = tcpCapable(registries);
  if (candidates.length === 0) return [];
  const responders = await snmpBroadcast(PRINTER_MIB.hrDeviceDescr, opts);
  const settled = await Promise.allSettled(
    responders.map(async ({ address, value }) => {
      const modelName = asString(value);
      const descriptor = modelName === undefined ? undefined : matchTcp(modelName, candidates);
      if (modelName === undefined || descriptor === undefined) {
        return identifyNetworkDevice(address, candidates, opts);
      }
      return networkDevice(descriptor, address, modelName, await fetchSerial(address, opts));
    }),
  );
  const out: EnumeratedNetworkDevice[] = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value !== undefined) out.push(r.value);
  }
  return out.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}
