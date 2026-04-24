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

const inEndpoint = new MockInEndpoint();
const outEndpoint = new MockOutEndpoint();

const iface = {
  claim: vi.fn(),
  isKernelDriverActive: vi.fn(() => false),
  detachKernelDriver: vi.fn(),
  releaseAsync: vi.fn(() => Promise.resolve()),
  endpoints: [inEndpoint, outEndpoint] as unknown[],
};

const device = {
  deviceDescriptor: { idVendor: 0x04f9, idProduct: 0x2028 },
  open: vi.fn(),
  close: vi.fn(),
  interface: vi.fn(() => iface),
};

const deviceList: (typeof device)[] = [];

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

  beforeEach(() => {
    vi.clearAllMocks();
    deviceList.length = 0;
    iface.isKernelDriverActive.mockReturnValue(false);
    inEndpoint.timeout = 0;
    inEndpoint.transferAsync.mockReset();
    outEndpoint.transferAsync.mockReset().mockResolvedValue(0);
    iface.endpoints = [inEndpoint, outEndpoint];
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

  it('openDevice() rejects descriptors without vid or pid', async () => {
    const { UsbTransport } = await loadTransport();
    await expect(
      UsbTransport.openDevice({
        name: 'Network-only printer',
        family: 'labelwriter',
        transports: ['tcp'],
      }),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it('openDevice() delegates to open() when vid/pid are set', async () => {
    deviceList.push(device);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.openDevice({
      name: 'Brother QL-820NWB',
      family: 'brother-ql',
      transports: ['usb'],
      vid: 0x04f9,
      pid: 0x2028,
    });
    expect(transport.connected).toBe(true);
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

  it('close() is idempotent', async () => {
    deviceList.push(device);
    const { UsbTransport } = await loadTransport();
    const transport = await UsbTransport.open(0x04f9, 0x2028);
    await transport.close();
    await transport.close();
    expect(iface.releaseAsync).toHaveBeenCalledOnce();
    expect(device.close).toHaveBeenCalledOnce();
  });
});
