import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  TransportClosedError,
  TransportError,
  TransportTimeoutError,
} from '@thermal-label/contracts';
import type * as TcpModule from '../node/tcp.js';

class MockSocket extends EventEmitter {
  connectImpl: (port: number, host: string, cb: () => void) => void = (_p, _h, cb) => {
    setImmediate(cb);
  };
  write = vi.fn<(buf: Buffer, cb: (err?: Error) => void) => boolean>(
    (_buf: Buffer, cb: (err?: Error) => void) => {
      setImmediate(cb);
      return true;
    },
  );
  end = vi.fn<(cb: () => void) => void>((cb: () => void) => {
    setImmediate(cb);
  });
  destroy = vi.fn();
  connect(port: number, host: string, cb: () => void): void {
    this.connectImpl(port, host, cb);
  }
}

let lastSocket: MockSocket;

vi.mock('node:net', () => ({
  Socket: vi.fn(() => {
    lastSocket = new MockSocket();
    return lastSocket;
  }),
}));

async function loadTransport(): Promise<typeof TcpModule> {
  return import('../node/tcp.js');
}

describe('TcpTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect() creates socket and dials host:port', async () => {
    const { TcpTransport } = await loadTransport();
    const connectSpy = vi.fn<(port: number, host: string, cb: () => void) => void>((_p, _h, cb) => {
      setImmediate(cb);
    });
    lastSocket = new MockSocket();
    lastSocket.connectImpl = connectSpy;
    // Replace the Socket constructor mock to return our pre-built instance
    const net = (await import('node:net')) as unknown as { Socket: ReturnType<typeof vi.fn> };
    net.Socket.mockImplementationOnce(() => lastSocket);

    const transport = await TcpTransport.connect('192.0.2.10', 9100);
    expect(connectSpy).toHaveBeenCalledWith(9100, '192.0.2.10', expect.any(Function));
    expect(transport.connected).toBe(true);
  });

  it('connect() defaults to port 9100', async () => {
    const { TcpTransport } = await loadTransport();
    const connectSpy = vi.fn<(port: number, host: string, cb: () => void) => void>((_p, _h, cb) => {
      setImmediate(cb);
    });
    const sock = new MockSocket();
    sock.connectImpl = connectSpy;
    const net = (await import('node:net')) as unknown as { Socket: ReturnType<typeof vi.fn> };
    net.Socket.mockImplementationOnce(() => sock);

    await TcpTransport.connect('printer.local');
    expect(connectSpy).toHaveBeenCalledWith(9100, 'printer.local', expect.any(Function));
  });

  it('connect() times out with TransportError (not TransportTimeoutError)', async () => {
    const { TcpTransport } = await loadTransport();
    const neverConnect = vi.fn<(port: number, host: string, cb: () => void) => void>(() => {
      /* never resolve */
    });
    const sock = new MockSocket();
    sock.connectImpl = neverConnect;
    const net = (await import('node:net')) as unknown as { Socket: ReturnType<typeof vi.fn> };
    net.Socket.mockImplementationOnce(() => sock);

    vi.useFakeTimers();
    const promise = TcpTransport.connect('192.0.2.1', 9100, 100);
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toSatisfy(
      err => err instanceof TransportError && !(err instanceof TransportTimeoutError),
    );
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('connect() rejects on socket error', async () => {
    const { TcpTransport } = await loadTransport();
    const sock = new MockSocket();
    sock.connectImpl = () => {
      setImmediate(() => sock.emit('error', new Error('ECONNREFUSED')));
    };
    const net = (await import('node:net')) as unknown as { Socket: ReturnType<typeof vi.fn> };
    net.Socket.mockImplementationOnce(() => sock);

    await expect(TcpTransport.connect('192.0.2.1', 9100)).rejects.toThrow('ECONNREFUSED');
  });

  it('write() writes a Buffer to the socket', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    await transport.write(new Uint8Array([0x1b, 0x40]));
    expect(lastSocket.write).toHaveBeenCalledOnce();
    const arg = lastSocket.write.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(arg)).toBe(true);
    expect(Array.from(arg ?? Buffer.alloc(0))).toEqual([0x1b, 0x40]);
  });

  it('write() rejects when socket.write callback gets an error', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    lastSocket.write.mockImplementationOnce((_buf, cb) => {
      setImmediate(() => {
        cb(new Error('EPIPE'));
      });
      return true;
    });
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow('EPIPE');
  });

  it('write() tolerates backpressure (non-flushed) returns', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    lastSocket.write.mockImplementationOnce((_buf, cb) => {
      setImmediate(cb);
      return false;
    });
    await transport.write(new Uint8Array([1]));
    expect(lastSocket.write).toHaveBeenCalled();
  });

  it('read() returns requested bytes when the socket delivers them at once', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    setImmediate(() => lastSocket.emit('data', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
    const result = await transport.read(10);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('read() accumulates across partial data events (5 + 5)', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    const readPromise = transport.read(10);
    setImmediate(() => {
      lastSocket.emit('data', Buffer.from([1, 2, 3, 4, 5]));
      setImmediate(() => lastSocket.emit('data', Buffer.from([6, 7, 8, 9, 10])));
    });
    const result = await readPromise;
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('read() leaves remainder in buffer for next call', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    setImmediate(() => lastSocket.emit('data', Buffer.from([1, 2, 3, 4, 5])));
    const first = await transport.read(2);
    expect(Array.from(first)).toEqual([1, 2]);
    const second = await transport.read(3);
    expect(Array.from(second)).toEqual([3, 4, 5]);
  });

  it('read() throws TransportTimeoutError when data does not arrive in time', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    vi.useFakeTimers();
    const promise = transport.read(4, 100);
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('read() throws TransportClosedError if the socket closes mid-read', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    const readPromise = transport.read(10);
    setImmediate(() => lastSocket.emit('close'));
    await expect(readPromise).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('read() on a closed transport throws TransportClosedError', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    await transport.close();
    await expect(transport.read(1)).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('write() on a closed transport throws TransportClosedError', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    await transport.close();
    await expect(transport.write(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('close() ends the socket and flips connected to false', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    await transport.close();
    expect(lastSocket.end).toHaveBeenCalledOnce();
    expect(transport.connected).toBe(false);
  });

  it('close() is idempotent', async () => {
    const { TcpTransport } = await loadTransport();
    const transport = await TcpTransport.connect('printer', 9100);
    await transport.close();
    await transport.close();
    expect(lastSocket.end).toHaveBeenCalledOnce();
  });
});
