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
   * Request a BLE printer via the browser Bluetooth picker.
   *
   * Uses `BluetoothGattTransport` from the device descriptor to filter the
   * picker and resolve the TX / RX characteristics on the primary GATT
   * service. If `rxCharacteristicUuid` is omitted, the TX characteristic
   * is used for both directions (DECISIONS.md D6).
   */
  static async request(config: BluetoothGattTransport): Promise<WebBluetoothTransport> {
    const filters: BluetoothLEScanFilter[] = [
      config.namePrefix === undefined
        ? { services: [config.serviceUuid] }
        : { namePrefix: config.namePrefix, services: [config.serviceUuid] },
    ];
    const device = await navigator.bluetooth.requestDevice({
      filters,
      optionalServices: [config.serviceUuid],
    });
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
