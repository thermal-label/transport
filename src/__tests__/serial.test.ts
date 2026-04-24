import { TransportClosedError, TransportTimeoutError } from '@thermal-label/contracts';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SerialModule from '../node/serial.js';

type OpenCb = (err: Error | null) => void;
type WriteCb = (err?: Error | null) => void;

interface SerialPortInit {
  path: string;
  baudRate: number;
}

class MockSerialPort extends EventEmitter {
  static instances: MockSerialPort[] = [];
  static nextOpenError: Error | null = null;

  readonly path: string;
  readonly baudRate: number;
  write = vi.fn<(buf: Buffer, cb: WriteCb) => boolean>((_buf, cb) => {
    setImmediate(cb);
    return true;
  });
  drain = vi.fn<(cb: WriteCb) => void>(cb => {
    setImmediate(cb);
  });
  close = vi.fn<(cb: WriteCb) => void>(cb => {
    setImmediate(cb);
  });

  constructor(opts: SerialPortInit, openCallback?: OpenCb) {
    super();
    this.path = opts.path;
    this.baudRate = opts.baudRate;
    MockSerialPort.instances.push(this);
    const err = MockSerialPort.nextOpenError;
    MockSerialPort.nextOpenError = null;
    setImmediate(() => {
      openCallback?.(err);
    });
  }
}

vi.mock('serialport', () => ({
  SerialPort: MockSerialPort,
}));

async function loadTransport(): Promise<typeof SerialModule> {
  return import('../node/serial.js');
}

function lastInstance(): MockSerialPort {
  const inst = MockSerialPort.instances.at(-1);
  if (!inst) throw new Error('no SerialPort instance constructed');
  return inst;
}

describe('SerialTransport', () => {
  beforeEach(() => {
    MockSerialPort.instances.length = 0;
    MockSerialPort.nextOpenError = null;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('open() constructs SerialPort with path and baudRate', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0', 115200);
    const inst = lastInstance();
    expect(inst.path).toBe('/dev/rfcomm0');
    expect(inst.baudRate).toBe(115200);
    expect(transport.connected).toBe(true);
  });

  it('open() defaults baudRate to 9600', async () => {
    const { SerialTransport } = await loadTransport();
    await SerialTransport.open('/dev/rfcomm0');
    expect(lastInstance().baudRate).toBe(9600);
  });

  it('open() rejects if the serial port open callback errors', async () => {
    const { SerialTransport } = await loadTransport();
    MockSerialPort.nextOpenError = new Error('ENOENT');
    await expect(SerialTransport.open('/dev/does-not-exist')).rejects.toThrow('ENOENT');
  });

  it('write() forwards a Buffer and waits for drain', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    await transport.write(new Uint8Array([0x1b, 0x40]));
    const inst = lastInstance();
    expect(inst.write).toHaveBeenCalledOnce();
    const arg = inst.write.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(arg)).toBe(true);
    expect(Array.from(arg ?? Buffer.alloc(0))).toEqual([0x1b, 0x40]);
    expect(inst.drain).toHaveBeenCalledOnce();
  });

  it('write() rejects when the write callback reports an error', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    const inst = lastInstance();
    inst.write.mockImplementationOnce((_buf, cb) => {
      setImmediate(() => {
        cb(new Error('EIO'));
      });
      return true;
    });
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow('EIO');
    expect(inst.drain).not.toHaveBeenCalled();
  });

  it('write() rejects when drain reports an error', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    const inst = lastInstance();
    inst.drain.mockImplementationOnce(cb => {
      setImmediate(() => {
        cb(new Error('drain failed'));
      });
    });
    await expect(transport.write(new Uint8Array([1]))).rejects.toThrow('drain failed');
  });

  it('read() returns requested bytes when a single data event delivers them', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    const inst = lastInstance();
    setImmediate(() => inst.emit('data', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])));
    const result = await transport.read(10);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('read() accumulates across partial data events (5 + 5)', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    const inst = lastInstance();
    const readPromise = transport.read(10);
    setImmediate(() => {
      inst.emit('data', Buffer.from([1, 2, 3, 4, 5]));
      setImmediate(() => inst.emit('data', Buffer.from([6, 7, 8, 9, 10])));
    });
    const result = await readPromise;
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('read() leaves remainder in buffer for the next call', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    const inst = lastInstance();
    setImmediate(() => inst.emit('data', Buffer.from([1, 2, 3, 4, 5])));
    const first = await transport.read(2);
    expect(Array.from(first)).toEqual([1, 2]);
    const second = await transport.read(3);
    expect(Array.from(second)).toEqual([3, 4, 5]);
  });

  it('read() throws TransportTimeoutError when data does not arrive in time', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    vi.useFakeTimers();
    const promise = transport.read(4, 100);
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('read() throws TransportClosedError when the port closes mid-read', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    const inst = lastInstance();
    const readPromise = transport.read(10);
    setImmediate(() => inst.emit('close'));
    await expect(readPromise).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('read() on a closed transport throws TransportClosedError', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    await transport.close();
    await expect(transport.read(1)).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('write() on a closed transport throws TransportClosedError', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    await transport.close();
    await expect(transport.write(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('close() calls port.close and flips connected to false', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    const inst = lastInstance();
    await transport.close();
    expect(inst.close).toHaveBeenCalledOnce();
    expect(transport.connected).toBe(false);
  });

  it('close() is idempotent', async () => {
    const { SerialTransport } = await loadTransport();
    const transport = await SerialTransport.open('/dev/rfcomm0');
    const inst = lastInstance();
    await transport.close();
    await transport.close();
    expect(inst.close).toHaveBeenCalledOnce();
  });
});
