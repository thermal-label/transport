import {
  DeviceNotFoundError,
  TransportClosedError,
  TransportTimeoutError,
  type DeviceDescriptor,
  type Transport,
} from '@thermal-label/contracts';
import type {
  Device,
  Endpoint,
  InEndpoint,
  Interface,
  OutEndpoint,
} from 'usb';

const INTERFACE_NUMBER = 0;

/**
 * USB transport over libusb for Node.js.
 *
 * Assumes a USB Printer Class device on interface 0. Covers every printer
 * family currently targeted by `@thermal-label/*` drivers
 * (LabelManager, LabelWriter, Brother QL).
 */
export class UsbTransport implements Transport {
  private readonly device: Device;
  private readonly iface: Interface;
  private readonly inEndpoint: InEndpoint;
  private readonly outEndpoint: OutEndpoint;
  private _connected = true;

  private constructor(
    device: Device,
    iface: Interface,
    inEndpoint: InEndpoint,
    outEndpoint: OutEndpoint,
  ) {
    this.device = device;
    this.iface = iface;
    this.inEndpoint = inEndpoint;
    this.outEndpoint = outEndpoint;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Open a USB Printer Class device by VID/PID.
   *
   * Enumerates via libusb, opens the device, claims interface 0, detaches
   * the `usblp` kernel driver on Linux if attached, and locates Bulk IN /
   * OUT endpoints.
   *
   * @throws DeviceNotFoundError if no matching device is attached.
   */
  static async open(vid: number, pid: number): Promise<UsbTransport> {
    const usbModule = await import('usb');
    const { getDeviceList } = usbModule;
    const InEndpointCtor = usbModule.InEndpoint;
    const OutEndpointCtor = usbModule.OutEndpoint;

    const device = getDeviceList().find(
      d => d.deviceDescriptor.idVendor === vid && d.deviceDescriptor.idProduct === pid,
    );
    if (!device) throw new DeviceNotFoundError(vid, pid);

    device.open();
    const iface = device.interface(INTERFACE_NUMBER);

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
      throw new Error('USB device missing bulk IN or OUT endpoint on interface 0');
    }

    return new UsbTransport(device, iface, inEndpoint, outEndpoint);
  }

  /**
   * Convenience wrapper for opening a device from a `DeviceDescriptor`.
   *
   * @throws DeviceNotFoundError if the descriptor has no VID or PID
   *   (network-only printers cannot be opened over USB).
   */
  static async openDevice(descriptor: DeviceDescriptor): Promise<UsbTransport> {
    if (descriptor.vid === undefined || descriptor.pid === undefined) {
      throw new DeviceNotFoundError(descriptor.vid, descriptor.pid);
    }
    return UsbTransport.open(descriptor.vid, descriptor.pid);
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
    this.device.close();
  }
}
