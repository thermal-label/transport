import { TransportClosedError, TransportTimeoutError } from '@thermal-label/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSerialTransport } from '../web/web-serial.js';

interface ReaderMock {
  read: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
  pushChunk(bytes: number[]): void;
  pushDone(): void;
  pushError(err: Error): void;
}

interface WriterMock {
  write: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
}

interface PortMock {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  reader: ReaderMock;
  writer: WriterMock;
  readable: { getReader: () => ReaderMock };
  writable: { getWriter: () => WriterMock };
}

function makeReader(): ReaderMock {
  const queue: { value?: Uint8Array; done: boolean; error?: Error }[] = [];
  const pending: {
    resolve: (v: { value?: Uint8Array; done: boolean }) => void;
    reject: (err: Error) => void;
  }[] = [];

  const deliver = (): void => {
    while (queue.length > 0 && pending.length > 0) {
      const item = queue.shift();
      const waiter = pending.shift();
      if (!item || !waiter) continue;
      if (item.error) {
        waiter.reject(item.error);
      } else if (item.value === undefined) {
        waiter.resolve({ done: item.done });
      } else {
        waiter.resolve({ value: item.value, done: item.done });
      }
    }
  };

  const reader: ReaderMock = {
    read: vi.fn(
      () =>
        new Promise<{ value?: Uint8Array; done: boolean }>((resolve, reject) => {
          pending.push({ resolve, reject });
          deliver();
        }),
    ),
    cancel: vi.fn(() => {
      queue.push({ done: true });
      deliver();
      return Promise.resolve();
    }),
    releaseLock: vi.fn(),
    pushChunk(bytes) {
      queue.push({ value: new Uint8Array(bytes), done: false });
      deliver();
    },
    pushDone() {
      queue.push({ done: true });
      deliver();
    },
    pushError(err) {
      queue.push({ done: false, error: err });
      deliver();
    },
  };
  return reader;
}

function makeWriter(): WriterMock {
  return {
    write: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    releaseLock: vi.fn(),
  };
}

function makePort(): PortMock {
  const reader = makeReader();
  const writer = makeWriter();
  return {
    open: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    reader,
    writer,
    readable: { getReader: () => reader },
    writable: { getWriter: () => writer },
  };
}

function stubNavigator(port: PortMock): ReturnType<typeof vi.fn> {
  const requestPort = vi.fn().mockResolvedValue(port);
  vi.stubGlobal('navigator', {
    serial: {
      requestPort,
      getPorts: vi.fn().mockResolvedValue([]),
    },
  });
  return requestPort;
}

describe('WebSerialTransport', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('request() calls navigator.serial.requestPort with forwarded options', async () => {
    const port = makePort();
    const requestPort = stubNavigator(port);
    await WebSerialTransport.request({ allowedBluetoothServiceClassIds: [0x1101] });
    expect(requestPort).toHaveBeenCalledWith({ allowedBluetoothServiceClassIds: [0x1101] });
  });

  it('request() opens the port with the provided baudRate', async () => {
    const port = makePort();
    stubNavigator(port);
    await WebSerialTransport.request(undefined, 115200);
    expect(port.open).toHaveBeenCalledWith({ baudRate: 115200 });
  });

  it('request() defaults baudRate to 9600', async () => {
    const port = makePort();
    stubNavigator(port);
    await WebSerialTransport.request();
    expect(port.open).toHaveBeenCalledWith({ baudRate: 9600 });
  });

  it('fromPort() opens the port and acquires reader/writer', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    expect(port.open).toHaveBeenCalledWith({ baudRate: 9600 });
    expect(transport.connected).toBe(true);
  });

  it('fromPort() throws and closes the port when streams are unavailable', async () => {
    const port = makePort();
    (port as unknown as { readable: null }).readable = null;
    await expect(WebSerialTransport.fromPort(port as unknown as SerialPort)).rejects.toThrow(
      /no readable or writable/,
    );
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('write() forwards a Uint8Array through the writer', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    const data = new Uint8Array([0x1b, 0x40]);
    await transport.write(data);
    expect(port.writer.write).toHaveBeenCalledOnce();
    expect(Array.from(port.writer.write.mock.calls[0]?.[0] as Uint8Array)).toEqual([0x1b, 0x40]);
  });

  it('read() resolves from data pushed before the call', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    port.reader.pushChunk([1, 2, 3, 4, 5]);
    // Yield so the pump loop can consume the chunk
    await new Promise(r => setImmediate(r));
    const result = await transport.read(3);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it('read() accumulates across multiple chunks (2 + 3)', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    const promise = transport.read(5);
    port.reader.pushChunk([1, 2]);
    port.reader.pushChunk([3, 4, 5]);
    const result = await promise;
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('read() leaves remainder in buffer for the next call', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    port.reader.pushChunk([1, 2, 3, 4, 5]);
    await new Promise(r => setImmediate(r));
    const first = await transport.read(2);
    expect(Array.from(first)).toEqual([1, 2]);
    const second = await transport.read(3);
    expect(Array.from(second)).toEqual([3, 4, 5]);
  });

  it('read() throws TransportTimeoutError when data does not arrive in time', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    vi.useFakeTimers();
    const promise = transport.read(4, 100);
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('read() rejects with TransportClosedError when the stream ends mid-read', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    const promise = transport.read(10);
    port.reader.pushDone();
    await expect(promise).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('read() on a closed transport throws TransportClosedError', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    await transport.close();
    await expect(transport.read(1)).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('write() on a closed transport throws TransportClosedError', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    await transport.close();
    await expect(transport.write(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('close() cancels reader, closes writer, and closes the port', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    await transport.close();
    expect(port.reader.cancel).toHaveBeenCalledOnce();
    expect(port.writer.close).toHaveBeenCalledOnce();
    expect(port.close).toHaveBeenCalledOnce();
    expect(transport.connected).toBe(false);
  });

  it('close() tolerates writer.close() rejecting', async () => {
    const port = makePort();
    port.writer.close.mockRejectedValueOnce(new Error('writer errored'));
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    await expect(transport.close()).resolves.toBeUndefined();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it('close() is idempotent', async () => {
    const port = makePort();
    const transport = await WebSerialTransport.fromPort(port as unknown as SerialPort);
    await transport.close();
    await transport.close();
    expect(port.close).toHaveBeenCalledOnce();
  });
});
