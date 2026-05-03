import {
  DeviceNotFoundError,
  TransportClosedError,
  TransportTimeoutError,
  type DeviceEntry,
  type Transport,
} from '@thermal-label/contracts';
import type { Device, Endpoint, InEndpoint, Interface, OutEndpoint } from 'usb';

const DEFAULT_INTERFACE_NUMBER = 0;

export interface UsbOpenOptions {
  /** USB interface to claim. Defaults to 0. */
  bInterfaceNumber?: number;
}

interface DeviceCacheEntry {
  device: Device;
  refcount: number;
}

const deviceCache = new Map<string, DeviceCacheEntry>();

function deviceCacheKey(vid: number, pid: number): string {
  return `${vid.toString()}:${pid.toString()}`;
}

async function acquireDevice(
  vid: number,
  pid: number,
): Promise<{ device: Device; release: () => void }> {
  const key = deviceCacheKey(vid, pid);
  const cached = deviceCache.get(key);
  if (cached) {
    cached.refcount += 1;
    return {
      device: cached.device,
      release: () => {
        releaseDevice(key);
      },
    };
  }

  const { getDeviceList } = await import('usb');
  const device = getDeviceList().find(
    d => d.deviceDescriptor.idVendor === vid && d.deviceDescriptor.idProduct === pid,
  );
  if (!device) throw new DeviceNotFoundError(vid, pid);

  device.open();
  deviceCache.set(key, { device, refcount: 1 });
  return {
    device,
    release: () => {
      releaseDevice(key);
    },
  };
}

function releaseDevice(key: string): void {
  const entry = deviceCache.get(key);
  if (!entry) return;
  entry.refcount -= 1;
  if (entry.refcount <= 0) {
    deviceCache.delete(key);
    entry.device.close();
  }
}

/**
 * Test-only: clear the device cache without calling `device.close()` on
 * cached entries. Not part of the public API; do not call from production
 * code.
 */
export function __resetDeviceCacheForTests(): void {
  deviceCache.clear();
}

/**
 * USB transport over libusb for Node.js.
 *
 * Defaults to interface 0 — covering single-interface printer-class
 * devices used by `@thermal-label/*` drivers (LabelManager, LabelWriter,
 * Brother QL). Pass `{ bInterfaceNumber }` to claim a different
 * interface; this is needed for composite devices like the LabelWriter
 * 450 Duo, which exposes one interface per engine.
 *
 * Two transports may be opened against the same `(vid, pid)` device on
 * different interfaces; they share the underlying libusb handle via an
 * internal refcounted cache so that closing one does not invalidate the
 * other.
 */
export class UsbTransport implements Transport {
  private readonly iface: Interface;
  private readonly inEndpoint: InEndpoint;
  private readonly outEndpoint: OutEndpoint;
  private readonly releaseDevice: () => void;
  private _connected = true;

  private constructor(
    iface: Interface,
    inEndpoint: InEndpoint,
    outEndpoint: OutEndpoint,
    release: () => void,
  ) {
    this.iface = iface;
    this.inEndpoint = inEndpoint;
    this.outEndpoint = outEndpoint;
    this.releaseDevice = release;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Open a USB Printer Class device by VID/PID.
   *
   * Enumerates via libusb, opens (or refcount-acquires) the device,
   * claims the requested interface, detaches the `usblp` kernel driver
   * on Linux if attached, and locates Bulk IN / OUT endpoints on that
   * interface.
   *
   * @throws DeviceNotFoundError if no matching device is attached.
   */
  static async open(vid: number, pid: number, options?: UsbOpenOptions): Promise<UsbTransport> {
    const interfaceNumber = options?.bInterfaceNumber ?? DEFAULT_INTERFACE_NUMBER;

    const usbModule = await import('usb');
    const InEndpointCtor = usbModule.InEndpoint;
    const OutEndpointCtor = usbModule.OutEndpoint;

    const { device, release } = await acquireDevice(vid, pid);

    try {
      const exists = device.interfaces?.some(i => i.interfaceNumber === interfaceNumber) ?? false;
      if (!exists) {
        throw new Error(`USB device has no interface ${interfaceNumber.toString()}`);
      }
      const iface = device.interface(interfaceNumber);

      // On Linux the `usblp` kernel driver auto-claims printer-class
      // interfaces. Detach before libusb can claim. Safe no-op on other
      // platforms and when no driver is attached.
      if (process.platform === 'linux' && iface.isKernelDriverActive()) {
        iface.detachKernelDriver();
      }
      iface.claim();

      const inEndpoint = iface.endpoints.find(
        (e: Endpoint): e is InEndpoint => e instanceof InEndpointCtor,
      );
      const outEndpoint = iface.endpoints.find(
        (e: Endpoint): e is OutEndpoint => e instanceof OutEndpointCtor,
      );

      if (!inEndpoint || !outEndpoint) {
        throw new Error(
          `USB device missing bulk IN or OUT endpoint on interface ${interfaceNumber.toString()}`,
        );
      }

      return new UsbTransport(iface, inEndpoint, outEndpoint, release);
    } catch (err) {
      release();
      throw err;
    }
  }

  /**
   * Convenience wrapper for opening a device from a `DeviceEntry`.
   *
   * @throws DeviceNotFoundError if the entry has no `transports.usb`
   *   block (network-only printers cannot be opened over USB).
   */
  static async openDevice(entry: DeviceEntry, options?: UsbOpenOptions): Promise<UsbTransport> {
    const usb = entry.transports.usb;
    if (!usb) throw new DeviceNotFoundError();
    return UsbTransport.open(parseInt(usb.vid, 16), parseInt(usb.pid, 16), options);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('usb');
    await this.outEndpoint.transferAsync(Buffer.from(data));
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('usb');
    this.inEndpoint.timeout = timeout ?? 0;
    try {
      const buf = await this.inEndpoint.transferAsync(length);
      return buf ? new Uint8Array(buf) : new Uint8Array(0);
    } catch (err) {
      if (timeout !== undefined) {
        const { LibUSBException, usb } = await import('usb');
        if (err instanceof LibUSBException && err.errno === usb.LIBUSB_ERROR_TIMEOUT) {
          throw new TransportTimeoutError('usb', timeout);
        }
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    await this.iface.releaseAsync();
    this.releaseDevice();
  }
}
