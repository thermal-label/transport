import {
  TransportClosedError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';
import type { SerialPort } from 'serialport';

const DEFAULT_BAUD_RATE = 9600;

/**
 * Node.js serial-port transport.
 *
 * Covers three physical pipes that all look the same to userspace:
 * - Bluetooth SPP via `/dev/rfcomm0` (Linux, after `bluetoothctl` pair +
 *   `rfcomm bind`) or `COM<n>` (Windows, auto-assigned after pairing).
 *   macOS dropped classic Bluetooth SPP — no serial route there.
 * - USB-to-serial adapters via `/dev/ttyUSB0`, `/dev/ttyACM0`, `COM<n>`.
 * - Native UARTs on embedded boards.
 *
 * Baud rate is forwarded to the OS driver. For RFCOMM it is ignored by
 * the underlying link (flow control is on the Bluetooth layer), but the
 * `serialport` API requires a value — default 9600.
 *
 * Buffering pattern matches `TcpTransport`: incoming `data` events push
 * chunks into a `Buffer[]`, and `read(n)` resolves once enough bytes are
 * queued.
 */
export class SerialTransport implements Transport {
  private readonly port: SerialPort;
  private readonly chunks: Buffer[] = [];
  private waiter: {
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    needed: number;
    timer: NodeJS.Timeout | undefined;
  } | null = null;
  private _connected = true;

  private constructor(port: SerialPort) {
    this.port = port;
    port.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.satisfyWaiter();
    });
    port.on('close', () => {
      this._connected = false;
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new TransportClosedError('serial'));
      }
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Open a serial port by path.
   *
   * @param path - OS-specific device path (e.g. `/dev/rfcomm0`,
   *   `/dev/ttyUSB0`, `COM3`).
   * @param baudRate - Serial baud rate. Default 9600. Ignored for
   *   Bluetooth SPP but required by the `serialport` API.
   */
  static async open(path: string, baudRate: number = DEFAULT_BAUD_RATE): Promise<SerialTransport> {
    const { SerialPort } = await import('serialport');
    return new Promise((resolve, reject) => {
      const port = new SerialPort({ path, baudRate }, (err: Error | null) => {
        if (err) reject(err);
        else resolve(new SerialTransport(port));
      });
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('serial');
    await new Promise<void>((resolve, reject) => {
      this.port.write(Buffer.from(data), (err: Error | null | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        this.port.drain((drainErr: Error | null) => {
          if (drainErr) reject(drainErr);
          else resolve();
        });
      });
    });
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('serial');

    if (this.bufferedLength() >= length) {
      return this.drainBuffer(length);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              if (this.waiter?.timer === timer) this.waiter = null;
              reject(new TransportTimeoutError('serial', timeout));
            }, timeout);
      this.waiter = { resolve, reject, needed: length, timer };
    });
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    await new Promise<void>((resolve, reject) => {
      this.port.close((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private bufferedLength(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    return total;
  }

  private drainBuffer(length: number): Uint8Array {
    const combined = Buffer.concat(this.chunks);
    this.chunks.length = 0;
    const result = combined.subarray(0, length);
    const remainder = combined.subarray(length);
    if (remainder.length > 0) this.chunks.push(Buffer.from(remainder));
    return new Uint8Array(result);
  }

  private satisfyWaiter(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    if (this.bufferedLength() < waiter.needed) return;
    this.waiter = null;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(this.drainBuffer(waiter.needed));
  }
}
