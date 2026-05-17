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
  /** `wMaxPacketSize` of the bulk IN endpoint — see `read()`. */
  private readonly packetSizeIn: number;
  private _connected = true;

  private constructor(
    device: USBDevice,
    interfaceNumber: number,
    endpointOut: number,
    endpointIn: number,
    packetSizeIn: number,
  ) {
    this.device = device;
    this.interfaceNumber = interfaceNumber;
    this.endpointOut = endpointOut;
    this.endpointIn = endpointIn;
    this.packetSizeIn = packetSizeIn;
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

    // `inEp.packetSize` is the endpoint's `wMaxPacketSize`. `|| 64` is a
    // defensive floor: a `0`/`undefined` would make `read()`'s round-up
    // produce `NaN`. Rounding a small read up to 64 is harmless — the
    // device's short packet still terminates the transfer.
    const packetSizeIn = inEp.packetSize || 64;

    // Kept deliberately: `read()` rounds transfers up to the IN endpoint's
    // packet size, so a retest log should *state* the resolved size rather
    // than have anyone guess it.
    // eslint-disable-next-line no-console
    console.debug(
      `[transport/webusb] interface ${interfaceNumber.toString()}: ` +
        `IN endpoint ${inEp.endpointNumber.toString()}, packetSize ${packetSizeIn.toString()}`,
    );

    return new WebUsbTransport(
      device,
      interfaceNumber,
      outEp.endpointNumber,
      inEp.endpointNumber,
      packetSizeIn,
    );
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('usb');
    await this.device.transferOut(this.endpointOut, data);
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('usb');
    // Chromium WebUSB: `transferIn` must request a whole number of
    // `wMaxPacketSize`-sized packets, else the transfer can stall waiting
    // for a packet-aligned buffer the device never sends. Round the
    // request up to a packet multiple; the device's short packet still
    // terminates the transfer at the true message boundary. The result is
    // sliced back to the caller's requested length below, so the
    // `read(length)` contract is unchanged.
    const aligned = Math.ceil(length / this.packetSizeIn) * this.packetSizeIn;
    const transferPromise = this.device.transferIn(this.endpointIn, aligned);

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
    const full = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    if (result.data.byteLength === aligned) {
      // The transfer filled exactly with no short packet seen — for a
      // request/response device there may be more data queued. Should
      // never fire for LabelWriter responses; if it does, investigate.
      // eslint-disable-next-line no-console
      console.warn(
        `[transport/webusb] read filled exactly ${aligned.toString()} bytes with no ` +
          `short packet — device may have more data queued`,
      );
    }
    // `Math.min`, not a bare `subarray(0, length)`: if the device sent
    // fewer bytes than `length`, callers must see the real count so their
    // `bytes.length < EXPECTED` guards still fire.
    return full.subarray(0, Math.min(length, full.byteLength));
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    await this.device.releaseInterface(this.interfaceNumber);
    await this.device.close();
  }
}
