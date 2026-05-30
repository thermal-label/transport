import type { DeviceEntry } from '@thermal-label/contracts';
import type { Device } from 'usb';
import { matchDevice } from '../discovery.js';

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

async function tryReadSerial(
  device: Device,
  idx: number | undefined,
): Promise<string | undefined> {
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
