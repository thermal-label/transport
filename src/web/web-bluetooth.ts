import {
  TransportClosedError,
  TransportTimeoutError,
  type BluetoothGattTransport,
  type Transport,
} from '@thermal-label/contracts';

const DEFAULT_MTU = 20;

/**
 * Web Bluetooth transport for BLE thermal label printers
 * (Niimbot, Phomemo, Brother BLE, etc.).
 *
 * Browser only — Web Bluetooth in Chrome/Edge handles platform pairing,
 * GATT service discovery, and internal MTU negotiation uniformly across
 * platforms.
 *
 * Write path: data is split into MTU-sized chunks and sent sequentially
 * via `writeValueWithoutResponse`, yielding to the event loop between
 * chunks so the browser can drain its write queue.
 *
 * Read path: BLE has no "read N bytes" primitive, so this transport
 * listens for `characteristicvaluechanged` notifications on the RX
 * characteristic and accumulates them into a buffer. `read(n)` returns
 * from the buffer as soon as it holds at least `n` bytes.
 */
export class WebBluetoothTransport implements Transport {
  private readonly device: BluetoothDevice;
  private readonly txCharacteristic: BluetoothRemoteGATTCharacteristic;
  private readonly rxCharacteristic: BluetoothRemoteGATTCharacteristic;
  private readonly mtu: number;
  private readonly rxBuffer: number[] = [];
  private waiter: {
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    needed: number;
    timer: ReturnType<typeof setTimeout> | undefined;
  } | null = null;
  private _connected = true;

  private readonly onValueChanged = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const view = target.value;
    if (!view) return;
    for (let i = 0; i < view.byteLength; i++) {
      this.rxBuffer.push(view.getUint8(i));
    }
    this.satisfyWaiter();
  };

  private readonly onDisconnected = (): void => {
    this._connected = false;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new TransportClosedError('bluetooth-gatt'));
    }
  };

  private constructor(
    device: BluetoothDevice,
    txCharacteristic: BluetoothRemoteGATTCharacteristic,
    rxCharacteristic: BluetoothRemoteGATTCharacteristic,
    mtu: number,
  ) {
    this.device = device;
    this.txCharacteristic = txCharacteristic;
    this.rxCharacteristic = rxCharacteristic;
    this.mtu = mtu;

    device.addEventListener('gattserverdisconnected', this.onDisconnected);
    rxCharacteristic.addEventListener('characteristicvaluechanged', this.onValueChanged);
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Wrap a `BluetoothDevice` plus pre-resolved TX / RX characteristics.
   *
   * Use when discovery cannot be expressed through the canonical-UUID
   * filter that `request()` assumes — for example, drivers that match
   * services by UUID prefix and derive the characteristic UUIDs from
   * the matched service's tail at runtime (e.g. DYMO LetraTag,
   * DECISIONS.md D4 in the letratag repo).
   *
   * Caller is responsible for:
   *  - calling `device.gatt.connect()` and `getPrimaryService(...)`
   *  - resolving the TX and RX `BluetoothRemoteGATTCharacteristic`s
   *  - calling `rxCharacteristic.startNotifications()` before the first
   *    `read()` (the transport listens for `characteristicvaluechanged`
   *    events, but Web Bluetooth requires explicit notifications start)
   *
   * If `rxCharacteristic` is omitted, `txCharacteristic` is used for both
   * directions (DECISIONS.md D6).
   */
  static fromCharacteristics(
    device: BluetoothDevice,
    txCharacteristic: BluetoothRemoteGATTCharacteristic,
    rxCharacteristic?: BluetoothRemoteGATTCharacteristic,
    mtu?: number,
  ): WebBluetoothTransport {
    return new WebBluetoothTransport(
      device,
      txCharacteristic,
      rxCharacteristic ?? txCharacteristic,
      mtu ?? DEFAULT_MTU,
    );
  }

  /**
   * Request a BLE printer via the browser Bluetooth picker.
   *
   * Uses `BluetoothGattTransport` from the device descriptor to filter the
   * picker and resolve the TX / RX characteristics on the primary GATT
   * service. If `rxCharacteristicUuid` is omitted, the TX characteristic
   * is used for both directions (DECISIONS.md D6).
   */
  static async request(config: BluetoothGattTransport): Promise<WebBluetoothTransport> {
    const device = await navigator.bluetooth.requestDevice({
      filters: buildFilters([config]),
      optionalServices: [config.serviceUuid],
    });
    return WebBluetoothTransport.fromDevice(device, config);
  }

  /**
   * Open the picker with a *union* of multiple device configs — used
   * by transport-agnostic autodetect when the caller hasn't picked a
   * device key yet. The picker filters in any chassis whose
   * `namePrefix` / `serviceUuid` matches one of the configs; the
   * caller then identifies the chosen device (e.g. via
   * `identifyNiimbot`) before wrapping it in a transport.
   *
   * Returns the raw `BluetoothDevice` so the caller can both inspect
   * `.name` (the advertised name) and pair it with the right config
   * before calling `fromDevice()`. The GATT connection is not opened
   * here — that's the next step, gated on which config the autodetect
   * resolves to.
   *
   * `optionalServices` unions every config's service UUID so
   * `getPrimaryService(...)` works after pairing regardless of which
   * config the autodetect picks.
   */
  static async requestAny(
    configs: readonly BluetoothGattTransport[],
  ): Promise<BluetoothDevice> {
    if (configs.length === 0) {
      throw new Error('WebBluetoothTransport.requestAny: no configs supplied');
    }
    const uniqueServices = Array.from(new Set(configs.map(c => c.serviceUuid)));
    return navigator.bluetooth.requestDevice({
      filters: buildFilters(configs),
      optionalServices: uniqueServices,
    });
  }

  /**
   * Wrap a `BluetoothDevice` that the caller has already paired with
   * (typically via `requestAny` followed by autodetect). Connects
   * GATT, resolves TX / RX from the supplied `config`, and starts RX
   * notifications. Skips re-opening the picker — the device stays
   * the one the user already chose.
   *
   * Idempotent in the sense that `device.gatt.connect()` is a no-op
   * when the GATT server is already connected; safe to call after
   * `requestAny` even if the browser eagerly connected.
   */
  static async fromDevice(
    device: BluetoothDevice,
    config: BluetoothGattTransport,
  ): Promise<WebBluetoothTransport> {
    if (!device.gatt) throw new Error('Selected Bluetooth device has no GATT server');
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(config.serviceUuid);
    const tx = await service.getCharacteristic(config.txCharacteristicUuid);
    const rx =
      config.rxCharacteristicUuid === undefined
        ? tx
        : await service.getCharacteristic(config.rxCharacteristicUuid);
    await rx.startNotifications();
    return new WebBluetoothTransport(device, tx, rx, config.mtu ?? DEFAULT_MTU);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('bluetooth-gatt');
    for (let offset = 0; offset < data.length; offset += this.mtu) {
      const chunk = data.subarray(offset, offset + this.mtu);
      await this.txCharacteristic.writeValueWithoutResponse(chunk);
      if (offset + this.mtu < data.length) {
        await new Promise<void>(resolve => {
          setTimeout(resolve, 0);
        });
      }
    }
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('bluetooth-gatt');

    if (this.rxBuffer.length >= length) {
      return this.drainBuffer(length);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              if (this.waiter?.timer === timer) this.waiter = null;
              reject(new TransportTimeoutError('bluetooth-gatt', timeout));
            }, timeout);
      this.waiter = { resolve, reject, needed: length, timer };
    });
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    this.rxCharacteristic.removeEventListener('characteristicvaluechanged', this.onValueChanged);
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    try {
      await this.rxCharacteristic.stopNotifications();
    } catch {
      // Stopping notifications can fail if the device has already
      // disconnected — not fatal for close().
    }
    if (this.device.gatt?.connected) {
      this.device.gatt.disconnect();
    }
  }

  private drainBuffer(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.rxBuffer[i] ?? 0;
    }
    this.rxBuffer.splice(0, length);
    return out;
  }

  private satisfyWaiter(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.rxBuffer.length < waiter.needed) return;
    this.waiter = null;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(this.drainBuffer(waiter.needed));
  }
}

/**
 * Build the browser-picker filter array from one or more
 * `BluetoothGattTransport` configs.
 *
 * Web Bluetooth filters check the device's *advertisement*, not its
 * GATT table. Some chassis (e.g. Niimbot B1, 2024+ firmware) host
 * the driver's primary service in GATT but only advertise a generic
 * BLE-UART service (MCHP 49535343-…) instead. With a service-only
 * filter the picker would never see them.
 *
 * OR-fallback: when `namePrefix` is set on a config, emit both a
 * strict `{ namePrefix, services }` filter and a name-only one. The
 * picker treats the filter array as an OR; strict filters come
 * first so service-advertising chassis rank higher on browsers that
 * preserve filter order.
 *
 * Multi-config callers (`requestAny`) concatenate per-config filters
 * — the picker shows every chassis matching any of the configs,
 * which is exactly the discovery surface autodetect wants.
 */
function buildFilters(
  configs: readonly BluetoothGattTransport[],
): BluetoothLEScanFilter[] {
  const out: BluetoothLEScanFilter[] = [];
  for (const config of configs) {
    if (config.namePrefix === undefined) {
      out.push({ services: [config.serviceUuid] });
    } else {
      out.push({ namePrefix: config.namePrefix, services: [config.serviceUuid] });
      out.push({ namePrefix: config.namePrefix });
    }
  }
  return out;
}
