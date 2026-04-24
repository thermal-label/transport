import {
  TransportClosedError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';

const INTERFACE_NUMBER = 0;
const CONFIGURATION_VALUE = 1;

/**
 * WebUSB transport for browser environments.
 *
 * Assumes a USB Printer Class device on interface 0 — the same
 * assumption as `UsbTransport` for Node.js. Callers obtain a
 * `USBDevice` via `navigator.usb.requestDevice()` (prompts the user) or
 * `navigator.usb.getDevices()` (previously paired).
 */
export class WebUsbTransport implements Transport {
  private readonly device: USBDevice;
  private readonly interfaceNumber: number;
  private readonly endpointOut: number;
  private readonly endpointIn: number;
  private _connected = true;

  private constructor(
    device: USBDevice,
    interfaceNumber: number,
    endpointOut: number,
    endpointIn: number,
  ) {
    this.device = device;
    this.interfaceNumber = interfaceNumber;
    this.endpointOut = endpointOut;
    this.endpointIn = endpointIn;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Show the browser's USB picker and wrap the selected device.
   *
   * @param filters - USB device filters (typically `{ vendorId, productId }`
   *   pairs built by `buildUsbFilters`).
   */
  static async request(filters: USBDeviceFilter[]): Promise<WebUsbTransport> {
    const device = await navigator.usb.requestDevice({ filters });
    return WebUsbTransport.fromDevice(device);
  }

  /**
   * Wrap an already-selected `USBDevice`.
   *
   * Opens the device, selects configuration 1, claims interface 0, and
   * resolves the bulk IN / OUT endpoint numbers from the interface
   * descriptor. Use this when the `USBDevice` came from
   * `navigator.usb.getDevices()` (previously paired devices) or from
   * external code.
   */
  static async fromDevice(device: USBDevice): Promise<WebUsbTransport> {
    await device.open();
    if (device.configuration?.configurationValue !== CONFIGURATION_VALUE) {
      await device.selectConfiguration(CONFIGURATION_VALUE);
    }
    await device.claimInterface(INTERFACE_NUMBER);

    const iface = device.configuration?.interfaces.find(
      i => i.interfaceNumber === INTERFACE_NUMBER,
    );
    const endpoints = iface?.alternate.endpoints ?? [];
    const outEp = endpoints.find(e => e.direction === 'out');
    const inEp = endpoints.find(e => e.direction === 'in');

    if (!outEp || !inEp) {
      throw new Error('WebUSB device missing bulk IN or OUT endpoint on interface 0');
    }

    return new WebUsbTransport(device, INTERFACE_NUMBER, outEp.endpointNumber, inEp.endpointNumber);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('webusb');
    await this.device.transferOut(this.endpointOut, data);
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('webusb');
    const transferPromise = this.device.transferIn(this.endpointIn, length);

    const result =
      timeout === undefined
        ? await transferPromise
        : await Promise.race([
            transferPromise,
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new TransportTimeoutError('webusb', timeout));
              }, timeout);
            }),
          ]);

    if (!result.data) return new Uint8Array(0);
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    await this.device.releaseInterface(this.interfaceNumber);
    await this.device.close();
  }
}
