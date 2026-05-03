import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  DeviceNotFoundError,
  TransportClosedError,
  TransportTimeoutError,
} from '@thermal-label/contracts';
import type * as UsbModule from '../node/usb.js';

const LIBUSB_ERROR_TIMEOUT = -7;
const LIBUSB_ERROR_IO = -1;

class MockLibUSBException extends Error {
  constructor(
    message: string,
    public errno: number,
  ) {
    super(message);
    this.name = 'LibUSBException';
  }
}

class MockInEndpoint {
  direction = 'in' as const;
  timeout = 0;
  transferAsync = vi.fn<(length: number) => Promise<Buffer | undefined>>();
}

class MockOutEndpoint {
  direction = 'out' as const;
  transferAsync = vi.fn<(buffer: Buffer) => Promise<number>>(() => Promise.resolve(0));
}

interface MockInterface {
  interfaceNumber: number;
  claim: ReturnType<typeof vi.fn>;
  isKernelDriverActive: ReturnType<typeof vi.fn>;
  detachKernelDriver: ReturnType<typeof vi.fn>;
  releaseAsync: ReturnType<typeof vi.fn>;
  endpoints: unknown[];
  inEndpoint: MockInEndpoint;
  outEndpoint: MockOutEndpoint;
}

function makeInterface(interfaceNumber: number): MockInterface {
  const inEndpoint = new MockInEndpoint();
  const outEndpoint = new MockOutEndpoint();
  outEndpoint.transferAsync.mockResolvedValue(0);
  return {
    interfaceNumber,
    claim: vi.fn(),
    isKernelDriverActive: vi.fn(() => false),
    detachKernelDriver: vi.fn(),
    releaseAsync: vi.fn(() => Promise.resolve()),
    endpoints: [inEndpoint, outEndpoint],
    inEndpoint,
    outEndpoint,
  };
}

interface MockDevice {
  deviceDescriptor: { idVendor: number; idProduct: number };
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  interface: ReturnType<typeof vi.fn>;
  interfaces: MockInterface[];
}

function makeDevice(vid: number, pid: number, interfaceNumbers: number[] = [0]): MockDevice {
  const interfaces = interfaceNumbers.map(n => makeInterface(n));
  return {
    deviceDescriptor: { idVendor: vid, idProduct: pid },
    open: vi.fn(),
    close: vi.fn(),
    interface: vi.fn((n: number) => interfaces.find(i => i.interfaceNumber === n)),
    interfaces,
  };
}

function getInterface(device: MockDevice, n: number): MockInterface {
  const i = device.interfaces.find(x => x.interfaceNumber === n);
  if (!i) throw new Error(`mock device missing interface ${n.toString()}`);
  return i;
}

const deviceList: MockDevice[] = [];

vi.mock('usb', () => ({
  getDeviceList: (): typeof deviceList => deviceList,
  InEndpoint: MockInEndpoint,
  OutEndpoint: MockOutEndpoint,
  LibUSBException: MockLibUSBException,
  usb: { LIBUSB_ERROR_TIMEOUT },
}));

async function loadTransport(): Promise<typeof UsbModule> {
  return import('../node/usb.js');
}

describe('UsbTransport', () => {
  const originalPlatform = process.platform;
  let device: MockDevice;
  let iface: MockInterface;
  let inEndpoint: MockInEndpoint;
  let outEndpoint: MockOutEndpoint;

  beforeEach(async () => {
    vi.clearAllMocks();
    deviceList.length = 0;
    device = makeDevice(0x04f9, 0x2028);
    iface = getInterface(device, 0);
    inEndpoint = iface.inEndpoint;
    outEndpoint = iface.outEndpoint;
    const { __resetDeviceCacheForTests } = await loadTransport();
    __resetDeviceCacheForTests();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value });
  }

  it('open() finds device, claims interface 0, resolves endpoints', async () => {
    deviceList.push(device);
    setPlatform('darwin');
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    expect(transport.connected).toBe(true);
    expect(device.open).toHaveBeenCalledOnce();
    expect(device.interface).toHaveBeenCalledWith(0);
    expect(iface.claim).toHaveBeenCalledOnce();
    expect(iface.detachKernelDriver).not.toHaveBeenCalled();
  });

  it('open() detaches kernel driver on Linux when active', async () => {
    deviceList.push(device);
    setPlatform('linux');
    iface.isKernelDriverActive.mockReturnValue(true);
    const { UsbTransport } = await loadTransport();
    await UsbTransport.open(0x04f9, 0x2028);
    expect(iface.isKernelDriverActive).toHaveBeenCalled();
    expect(iface.detachKernelDriver).toHaveBeenCalledOnce();
  });

  it('open() skips kernel driver detach on non-Linux', async () => {
    deviceList.push(device);
    setPlatform('darwin');
    iface.isKernelDriverActive.mockReturnValue(true);
    const { UsbTransport } = await loadTransport();
    await UsbTransport.open(0x04f9, 0x2028);
    expect(iface.isKernelDriverActive).not.toHaveBeenCalled();
    expect(iface.detachKernelDriver).not.toHaveBeenCalled();
  });

  it('open() skips detach on Linux when no kernel driver attached', async () => {
    deviceList.push(device);
    setPlatform('linux');
    iface.isKernelDriverActive.mockReturnValue(false);
    const { UsbTransport } = await loadTransport();
    await UsbTransport.open(0x04f9, 0x2028);
    expect(iface.detachKernelDriver).not.toHaveBeenCalled();
  });

  it('open() throws DeviceNotFoundError when VID/PID not present', async () => {
    const { UsbTransport } = await loadTransport();
    await expect(UsbTransport.open(0xdead, 0xbeef)).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it('open() throws when the device has no bulk IN or OUT endpoint', async () => {
    deviceList.push(device);
    iface.endpoints = [outEndpoint];
    const { UsbTransport } = await loadTransport();
    await expect(UsbTransport.open(0x04f9, 0x2028)).rejects.toThrow(/bulk IN or OUT/);
  });

  it('openDevice() rejects entries without a usb transport', async () => {
    const { UsbTransport } = await loadTransport();
    await expect(
      UsbTransport.openDevice({
        key: 'NETWORK_ONLY',
        name: 'Network-only printer',
        family: 'labelwriter',
        transports: { tcp: { port: 9100 } },
        engines: [{ role: 'primary', protocol: 'lw-450', dpi: 300, headDots: 672 }],
        support: { status: 'untested' },
      }),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it('openDevice() delegates to open() when transports.usb is set', async () => {
    deviceList.push(device);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.openDevice({
      key: 'QL_820NWB',
      name: 'Brother QL-820NWB',
      family: 'brother-ql',
      transports: { usb: { vid: '0x04f9', pid: '0x2028' } },
      engines: [{ role: 'primary', protocol: 'brother-ql', dpi: 300, headDots: 720 }],
      support: { status: 'untested' },
    });
    expect(transport.connected).toBe(true);
  });

  it('openDevice() forwards bInterfaceNumber to open()', async () => {
    const composite = makeDevice(0x0922, 0x1003, [0, 1]);
    deviceList.push(composite);
    const { UsbTransport } = await loadTransport();
    await UsbTransport.openDevice(
      {
        key: 'LW_450_DUO_TAPE',
        name: 'LabelWriter 450 Duo (tape)',
        family: 'labelwriter',
        transports: { usb: { vid: '0x0922', pid: '0x1003' } },
        engines: [{ role: 'tape', protocol: 'lw-450', dpi: 300, headDots: 672 }],
        support: { status: 'untested' },
      },
      { bInterfaceNumber: 1 },
    );
    expect(composite.interface).toHaveBeenCalledWith(1);
  });

  it('write() sends a Buffer to the OUT endpoint', async () => {
    deviceList.push(device);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await transport.write(new Uint8Array([1, 2, 3]));
    expect(outEndpoint.transferAsync).toHaveBeenCalledOnce();
    const arg = outEndpoint.transferAsync.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(arg)).toBe(true);
    expect(Array.from(arg ?? Buffer.alloc(0))).toEqual([1, 2, 3]);
  });

  it('read() returns a Uint8Array (not Buffer)', async () => {
    deviceList.push(device);
    inEndpoint.transferAsync.mockResolvedValue(Buffer.from([0xaa, 0xbb]));
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    const result = await transport.read(2);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([0xaa, 0xbb]);
  });

  it('read() returns empty Uint8Array when transfer yields undefined', async () => {
    deviceList.push(device);
    // eslint-disable-next-line unicorn/no-useless-undefined -- simulating libusb returning undefined buffer
    inEndpoint.transferAsync.mockResolvedValue(undefined);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    const result = await transport.read(4);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it('read(length, timeout) sets inEndpoint.timeout', async () => {
    deviceList.push(device);
    inEndpoint.transferAsync.mockResolvedValue(Buffer.from([1]));
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await transport.read(1, 1500);
    expect(inEndpoint.timeout).toBe(1500);
  });

  it('read() maps LIBUSB_ERROR_TIMEOUT to TransportTimeoutError', async () => {
    deviceList.push(device);
    inEndpoint.transferAsync.mockRejectedValue(
      new MockLibUSBException('timed out', LIBUSB_ERROR_TIMEOUT),
    );
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await expect(transport.read(1, 500)).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('read() rethrows LibUSBException that is not a timeout', async () => {
    deviceList.push(device);
    const ioError = new MockLibUSBException('io error', LIBUSB_ERROR_IO);
    inEndpoint.transferAsync.mockRejectedValue(ioError);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await expect(transport.read(1, 500)).rejects.toBe(ioError);
  });

  it('read() rethrows timeout errors when caller did not pass a timeout', async () => {
    deviceList.push(device);
    const err = new MockLibUSBException('timed out', LIBUSB_ERROR_TIMEOUT);
    inEndpoint.transferAsync.mockRejectedValue(err);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await expect(transport.read(1)).rejects.toBe(err);
  });

  it('read() after close() throws TransportClosedError', async () => {
    deviceList.push(device);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await transport.close();
    await expect(transport.read(1)).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('write() after close() throws TransportClosedError', async () => {
    deviceList.push(device);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await transport.close();
    await expect(transport.write(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('close() releases interface and closes device', async () => {
    deviceList.push(device);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await transport.close();
    expect(iface.releaseAsync).toHaveBeenCalledOnce();
    expect(device.close).toHaveBeenCalledOnce();
    expect(transport.connected).toBe(false);
  });

  it('close() is idempotent and does not underflow the refcount', async () => {
    deviceList.push(device);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await transport.close();
    await transport.close();
    expect(iface.releaseAsync).toHaveBeenCalledOnce();
    expect(device.close).toHaveBeenCalledOnce();

    // A subsequent open of the same (vid, pid) must still work — proves
    // the cache entry was actually evicted, not stuck at refcount 0.
    deviceList.length = 0;
    const fresh = makeDevice(0x04f9, 0x2028);
    deviceList.push(fresh);
    const next = await UsbTransport.open(0x04f9, 0x2028);
    expect(fresh.open).toHaveBeenCalledOnce();
    await next.close();
  });

  describe('composite-device interface selection', () => {
    let composite: MockDevice;
    let iface0: MockInterface;
    let iface1: MockInterface;

    beforeEach(() => {
      composite = makeDevice(0x0922, 0x1003, [0, 1]);
      iface0 = getInterface(composite, 0);
      iface1 = getInterface(composite, 1);
      deviceList.push(composite);
    });

    it('open() with bInterfaceNumber claims that interface and uses its endpoints', async () => {
      const { UsbTransport } = await loadTransport();
      const transport = await UsbTransport.open(0x0922, 0x1003, { bInterfaceNumber: 1 });

      expect(composite.interface).toHaveBeenCalledWith(1);
      expect(iface1.claim).toHaveBeenCalledOnce();
      expect(iface0.claim).not.toHaveBeenCalled();

      // Writes go to iface 1's OUT endpoint, not iface 0's.
      await transport.write(new Uint8Array([0xaa]));
      expect(iface1.outEndpoint.transferAsync).toHaveBeenCalledOnce();
      expect(iface0.outEndpoint.transferAsync).not.toHaveBeenCalled();
    });

    it('two opens against the same device share the libusb handle (refcount)', async () => {
      const { UsbTransport } = await loadTransport();
      const label = await UsbTransport.open(0x0922, 0x1003, { bInterfaceNumber: 0 });
      const tape = await UsbTransport.open(0x0922, 0x1003, { bInterfaceNumber: 1 });

      expect(composite.open).toHaveBeenCalledOnce();
      expect(iface0.claim).toHaveBeenCalledOnce();
      expect(iface1.claim).toHaveBeenCalledOnce();

      await label.close();
      expect(iface0.releaseAsync).toHaveBeenCalledOnce();
      expect(composite.close).not.toHaveBeenCalled();

      await tape.close();
      expect(iface1.releaseAsync).toHaveBeenCalledOnce();
      expect(composite.close).toHaveBeenCalledOnce();
    });

    it('open() with non-existent bInterfaceNumber throws and releases the cache slot', async () => {
      const { UsbTransport } = await loadTransport();
      await expect(UsbTransport.open(0x0922, 0x1003, { bInterfaceNumber: 7 })).rejects.toThrow(
        /no interface 7/,
      );

      // Failed open evicted the cache (refcount went to 0): device.open
      // was called once and device.close was called once. A subsequent
      // open re-acquires cleanly rather than reusing a stale entry.
      expect(composite.open).toHaveBeenCalledOnce();
      expect(composite.close).toHaveBeenCalledOnce();

      const transport = await UsbTransport.open(0x0922, 0x1003, { bInterfaceNumber: 0 });
      expect(composite.open).toHaveBeenCalledTimes(2);
      await transport.close();
      expect(composite.close).toHaveBeenCalledTimes(2);
    });

    it('open() error message names the interface number', async () => {
      iface1.endpoints = [iface1.outEndpoint];
      const { UsbTransport } = await loadTransport();
      await expect(UsbTransport.open(0x0922, 0x1003, { bInterfaceNumber: 1 })).rejects.toThrow(
        /interface 1/,
      );
    });
  });
});
