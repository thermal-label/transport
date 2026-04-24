import {
  TransportClosedError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';

const DEFAULT_BAUD_RATE = 9600;

/**
 * Web Serial API transport.
 *
 * Covers two physical pipes that look the same to the browser:
 * - OS-paired Bluetooth SPP devices (e.g. Brother QL-820NWB on Linux
 *   after pairing via the OS Bluetooth settings, or on Windows after
 *   the same). macOS dropped classic Bluetooth SPP — no serial route
 *   there.
 * - USB-to-serial adapters.
 *
 * Browser only — Web Serial is Chrome/Edge (desktop and Android). The
 * caller is responsible for pairing Bluetooth devices at the OS level
 * first; the browser picker then lists them alongside wired ports.
 *
 * Read path: the `readable` stream delivers chunks of arbitrary size.
 * `read(n)` accumulates bytes until at least `n` are queued, matching
 * the pattern used by `TcpTransport` and `WebBluetoothTransport`.
 */
export class WebSerialTransport implements Transport {
  private readonly port: SerialPort;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly rxBuffer: number[] = [];
  private waiter: {
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    needed: number;
    timer: ReturnType<typeof setTimeout> | undefined;
  } | null = null;
  private readonly readLoop: Promise<void>;
  private _connected = true;

  private constructor(
    port: SerialPort,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {
    this.port = port;
    this.reader = reader;
    this.writer = writer;
    this.readLoop = this.pump();
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Show the browser's serial-port picker and wrap the selected port.
   *
   * Paired Bluetooth SPP devices appear alongside wired serial ports.
   * For ports exposing a custom RFCOMM service class, pass
   * `allowedBluetoothServiceClassIds` so the picker includes them —
   * ports with standard SPP (UUID `0x1101`) show up without a filter.
   *
   * @param options - Forwarded to `navigator.serial.requestPort`.
   * @param baudRate - Default 9600. Ignored for Bluetooth SPP (RFCOMM
   *   handles flow control) but required by the Web Serial API.
   */
  static async request(
    options?: SerialPortRequestOptions,
    baudRate: number = DEFAULT_BAUD_RATE,
  ): Promise<WebSerialTransport> {
    const port = await navigator.serial.requestPort(options);
    return WebSerialTransport.fromPort(port, baudRate);
  }

  /**
   * Wrap an already-obtained `SerialPort` that is NOT yet open.
   *
   * `fromPort` calls `port.open()` internally — pass the raw port
   * returned by `navigator.serial.getPorts()` (previously authorized
   * devices) or `navigator.serial.requestPort()`. Do not call
   * `port.open()` yourself first.
   */
  static async fromPort(
    port: SerialPort,
    baudRate: number = DEFAULT_BAUD_RATE,
  ): Promise<WebSerialTransport> {
    await port.open({ baudRate });
    const readable = port.readable;
    const writable = port.writable;
    if (!readable || !writable) {
      await port.close();
      throw new Error('Web Serial port has no readable or writable stream');
    }
    return new WebSerialTransport(port, readable.getReader(), writable.getWriter());
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('web-serial');
    await this.writer.write(data);
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('web-serial');

    if (this.rxBuffer.length >= length) {
      return this.drainBuffer(length);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              if (this.waiter?.timer === timer) this.waiter = null;
              reject(new TransportTimeoutError('web-serial', timeout));
            }, timeout);
      this.waiter = { resolve, reject, needed: length, timer };
    });
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(new TransportClosedError('web-serial'));
    }

    // Cancelling the reader releases its lock on the readable stream
    // and ends the pump loop so `port.close()` can succeed.
    try {
      await this.reader.cancel();
    } catch {
      // The reader may already be released if the stream errored.
    }
    try {
      await this.writer.close();
    } catch {
      // Closing a writer that already errored is not fatal.
    }
    await this.readLoop;
    await this.port.close();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value.byteLength === 0) continue;
        for (const byte of value) {
          this.rxBuffer.push(byte);
        }
        this.satisfyWaiter();
      }
    } catch {
      // A stream error ends the pump loop. If a caller is waiting on
      // read(), surface it as a TransportClosedError below.
    } finally {
      if (this._connected) {
        this._connected = false;
        const waiter = this.waiter;
        if (waiter) {
          this.waiter = null;
          if (waiter.timer) clearTimeout(waiter.timer);
          waiter.reject(new TransportClosedError('web-serial'));
        }
      }
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
