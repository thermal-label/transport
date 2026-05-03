import {
  TransportClosedError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';

const DEFAULT_INTERFACE_NUMBER = 0;
const DEFAULT_CONFIGURATION_VALUE = 1;

export interface WebUsbOpenOptions {
  /** USB interface to claim. Defaults to 0. */
  interfaceNumber?: number;
  /** USB configuration to select. Defaults to 1. */
  configurationValue?: number;
}

/**
 * WebUSB transport for browser environments.
 *
 * Defaults to interface 0 — the same default as Node's `UsbTransport`.
 * Pass `{ interfaceNumber }` to claim a different interface; this is
 * needed for composite devices like the LabelWriter 450 Duo, which
 * exposes one interface per engine. Callers obtain a `USBDevice` via
 * `navigator.usb.requestDevice()` (prompts the user) or
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
   * @param options - Optional interface/configuration selection.
   */
  static async request(
    filters: USBDeviceFilter[],
    options?: WebUsbOpenOptions,
  ): Promise<WebUsbTransport> {
    const device = await navigator.usb.requestDevice({ filters });
    return WebUsbTransport.fromDevice(device, options);
  }

  /**
   * Wrap an already-selected `USBDevice`.
   *
   * Opens the device, selects the requested configuration if it is not
   * already active, claims the requested interface, and resolves the
   * bulk IN / OUT endpoint numbers from that interface descriptor. Use
   * this when the `USBDevice` came from `navigator.usb.getDevices()`
   * (previously paired devices) or from external code.
   */
  static async fromDevice(
    device: USBDevice,
    options?: WebUsbOpenOptions,
  ): Promise<WebUsbTransport> {
    const interfaceNumber = options?.interfaceNumber ?? DEFAULT_INTERFACE_NUMBER;
    const configurationValue = options?.configurationValue ?? DEFAULT_CONFIGURATION_VALUE;

    await device.open();
    if (device.configuration?.configurationValue !== configurationValue) {
      await device.selectConfiguration(configurationValue);
    }
    await device.claimInterface(interfaceNumber);

    const iface = device.configuration?.interfaces.find(i => i.interfaceNumber === interfaceNumber);
    const endpoints = iface?.alternate.endpoints ?? [];
    const outEp = endpoints.find(e => e.direction === 'out');
    const inEp = endpoints.find(e => e.direction === 'in');

    if (!outEp || !inEp) {
      throw new Error(
        `WebUSB device missing bulk IN or OUT endpoint on interface ${interfaceNumber.toString()}`,
      );
    }

    return new WebUsbTransport(device, interfaceNumber, outEp.endpointNumber, inEp.endpointNumber);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('usb');
    await this.device.transferOut(this.endpointOut, data);
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('usb');
    const transferPromise = this.device.transferIn(this.endpointIn, length);

    const result =
      timeout === undefined
        ? await transferPromise
        : await Promise.race([
            transferPromise,
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new TransportTimeoutError('usb', timeout));
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
