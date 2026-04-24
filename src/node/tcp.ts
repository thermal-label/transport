import {
  TransportClosedError,
  TransportError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';
import { Socket } from 'node:net';

const DEFAULT_PORT = 9100;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/**
 * TCP transport for network-attached thermal label printers.
 *
 * Targets the JetDirect raw socket (port 9100) by default. Accumulates
 * incoming bytes across `data` events so `read(n)` hands callers a
 * pull-based API over a stream socket.
 */
export class TcpTransport implements Transport {
  private readonly socket: Socket;
  private readonly chunks: Buffer[] = [];
  private waiter: {
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    needed: number;
    timer: NodeJS.Timeout | undefined;
  } | null = null;
  private _connected = true;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.satisfyWaiter();
    });
    socket.on('close', () => {
      this._connected = false;
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new TransportClosedError('tcp'));
      }
    });
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Connect to a raw TCP printer port.
   *
   * @param host - IP address or hostname.
   * @param port - TCP port (default 9100).
   * @param timeout - Connection timeout in ms (default 5000). On expiry
   *   the returned promise rejects with `TransportError` (not
   *   `TransportTimeoutError`, which the contracts reserve for read
   *   timeouts).
   */
  static connect(
    host: string,
    port: number = DEFAULT_PORT,
    timeout?: number,
  ): Promise<TcpTransport> {
    const connectTimeoutMs = timeout ?? DEFAULT_CONNECT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          new TransportError(
            `TCP connect to ${host}:${port.toString()} timed out after ${connectTimeoutMs.toString()}ms`,
            'tcp',
          ),
        );
      }, connectTimeoutMs);

      socket.once('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });

      socket.connect(port, host, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new TcpTransport(socket));
      });
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('tcp');
    await new Promise<void>((resolve, reject) => {
      const flushed = this.socket.write(Buffer.from(data), err => {
        if (err) reject(err);
        else resolve();
      });
      if (!flushed) {
        this.socket.once('drain', () => {
          // The callback above still resolves/rejects; 'drain' just
          // indicates backpressure has cleared. No additional work needed.
        });
      }
    });
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('tcp');

    const buffered = this.bufferedLength();
    if (buffered >= length) {
      return this.drainBuffer(length);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              if (this.waiter?.timer === timer) this.waiter = null;
              reject(new TransportTimeoutError('tcp', timeout));
            }, timeout);
      this.waiter = { resolve, reject, needed: length, timer };
    });
  }

  async close(): Promise<void> {
    if (!this._connected) return;
    this._connected = false;
    await new Promise<void>(resolve => {
      this.socket.end(() => {
        resolve();
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
