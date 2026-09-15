import type {
  BluetoothGattTransport,
  DeviceEntry,
  DiscoveredPrinter,
  PrinterDiscovery,
} from '@thermal-label/contracts';

/**
 * Match a USB device against a list of known device entries.
 *
 * Entries without a `transports.usb` block (network-only printers) are
 * skipped — they cannot match a USB device. VID/PID hex strings on the
 * registry are parsed at the boundary.
 */
export function matchDevice(
  vid: number,
  pid: number,
  registries: readonly DeviceEntry[],
): DeviceEntry | undefined {
  return registries.find(d => {
    const usb = d.transports.usb;
    if (!usb) return false;
    return parseInt(usb.vid, 16) === vid && parseInt(usb.pid, 16) === pid;
  });
}

function modelTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 0);
}

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((token, j) => haystack[i + j] === token)) return true;
  }
  return false;
}

/**
 * Match a model string a device reports about itself — SNMP
 * `hrDeviceDescr` / `sysDescr`, IEEE-1284 `MDL:`, mDNS TXT `usb_MDL`,
 * IPP `printer-device-id` — against the registries' `modelNames`
 * (default `[name]`).
 *
 * Case-folded, whitespace-collapsed, whole-token: a candidate matches
 * when its tokens appear contiguously in the reported tokens, so a
 * vendor word in front (`Brother QL-820NWB`) is ignored and `QL-800`
 * never matches a `QL-8000`. The longest matching candidate wins; ties
 * go to registry order.
 */
export function matchModelName(
  reported: string,
  registries: readonly DeviceEntry[],
): DeviceEntry | undefined {
  const reportedTokens = modelTokens(reported);
  if (reportedTokens.length === 0) return undefined;
  let best: { entry: DeviceEntry; length: number } | undefined;
  for (const entry of registries) {
    for (const candidate of entry.modelNames ?? [entry.name]) {
      const candidateTokens = modelTokens(candidate);
      if (candidateTokens.length === 0 || !containsSequence(reportedTokens, candidateTokens)) {
        continue;
      }
      const length = candidateTokens.join(' ').length;
      if (best === undefined || length > best.length) best = { entry, length };
    }
  }
  return best?.entry;
}

/**
 * Build WebUSB filters from one or more device registries.
 *
 * Skips entries without a `transports.usb` block. Pass the result to
 * `navigator.usb.requestDevice({ filters })` or `WebUsbTransport.request`.
 */
export function buildUsbFilters(registries: readonly DeviceEntry[]): USBDeviceFilter[] {
  const filters: USBDeviceFilter[] = [];
  for (const d of registries) {
    const usb = d.transports.usb;
    if (!usb) continue;
    filters.push({ vendorId: parseInt(usb.vid, 16), productId: parseInt(usb.pid, 16) });
  }
  return filters;
}

/**
 * Build Web Bluetooth request options from a `BluetoothGattTransport`.
 *
 * Uses `filters[].services` (required so the user picker narrows to the
 * correct printer family) and `optionalServices` (required so the
 * returned `BluetoothDevice` is permitted to access the service). If
 * `namePrefix` is set, it is added to the filter to further narrow the
 * picker. See DECISIONS.md D2.
 */
export function buildBluetoothRequestOptions(config: BluetoothGattTransport): RequestDeviceOptions {
  const filter: BluetoothLEScanFilter =
    config.namePrefix === undefined
      ? { services: [config.serviceUuid] }
      : { namePrefix: config.namePrefix, services: [config.serviceUuid] };
  return {
    filters: [filter],
    optionalServices: [config.serviceUuid],
  };
}

/**
 * Build Web Serial request options, optionally including Bluetooth service
 * class IDs so paired SPP devices with custom UUIDs appear in the picker.
 *
 * For printers that advertise standard Serial Port Profile (UUID `0x1101`,
 * which is most thermal printers with classic Bluetooth), no options are
 * needed — pass the result as-is or call `WebSerialTransport.request()`
 * without arguments.
 *
 * For printers with a custom RFCOMM service class, pass those UUIDs here.
 */
export function buildSerialRequestOptions(
  bluetoothServiceClassIds?: readonly (number | string)[],
): SerialPortRequestOptions {
  if (!bluetoothServiceClassIds || bluetoothServiceClassIds.length === 0) {
    return {};
  }
  return { allowedBluetoothServiceClassIds: [...bluetoothServiceClassIds] };
}

/**
 * Universal printer discovery — aggregates results from multiple driver
 * implementations.
 *
 * Uses `Promise.allSettled` so one failing driver does not block others
 * (DECISIONS.md D5). Rejected results are dropped silently — callers
 * that need per-driver error detail should call the individual
 * `PrinterDiscovery.listPrinters()` directly.
 */
export async function discoverAll(
  discoveries: readonly PrinterDiscovery[],
): Promise<DiscoveredPrinter[]> {
  const results = await Promise.allSettled(discoveries.map(d => d.listPrinters()));
  const combined: DiscoveredPrinter[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') combined.push(...r.value);
  }
  return combined;
}
