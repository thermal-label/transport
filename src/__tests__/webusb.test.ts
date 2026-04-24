import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportClosedError, TransportTimeoutError } from '@thermal-label/contracts';
import { WebUsbTransport } from '../web/webusb.js';

interface MockDevice {
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  selectConfiguration: ReturnType<typeof vi.fn>;
  claimInterface: ReturnType<typeof vi.fn>;
  releaseInterface: ReturnType<typeof vi.fn>;
  transferOut: ReturnType<typeof vi.fn>;
  transferIn: ReturnType<typeof vi.fn>;
  configuration: USBConfiguration | null;
}

function makeConfiguration(
  endpoints: { endpointNumber: number; direction: string }[],
): USBConfiguration {
  return {
    configurationValue: 1,
    interfaces: [
      {
        interfaceNumber: 0,
        alternate: { endpoints },
      },
    ],
  } as unknown as USBConfiguration;
}

function makeDevice(
  configuration: USBConfiguration | null = makeConfiguration([
    { endpointNumber: 1, direction: 'out' },
    { endpointNumber: 2, direction: 'in' },
  ]),
): { mock: MockDevice; device: USBDevice } {
  const mock: MockDevice = {
    open: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    selectConfiguration: vi.fn(() => Promise.resolve()),
    claimInterface: vi.fn(() => Promise.resolve()),
    releaseInterface: vi.fn(() => Promise.resolve()),
    transferOut: vi.fn(() => Promise.resolve({ status: 'ok', bytesWritten: 0 })),
    transferIn: vi.fn(() =>
      Promise.resolve({
        status: 'ok',
        data: new DataView(new Uint8Array([1, 2, 3]).buffer),
      }),
    ),
    configuration,
  };
  return { mock, device: mock as unknown as USBDevice };
}

describe('WebUsbTransport', () => {
  let requestDevice: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useRealTimers();
    requestDevice = vi.fn();
    vi.stubGlobal('navigator', { usb: { requestDevice } });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('request() calls navigator.usb.requestDevice with filters and wraps the result', async () => {
    const { device } = makeDevice();
    requestDevice.mockResolvedValueOnce(device);
    const filters: USBDeviceFilter[] = [{ vendorId: 0x04f9, productId: 0x2028 }];
    const transport = await WebUsbTransport.request(filters);
    expect(requestDevice).toHaveBeenCalledWith({ filters });
    expect(transport.connected).toBe(true);
  });

  it('fromDevice() opens, claims interface 0, and discovers endpoints', async () => {
    const { mock, device } = makeDevice();
    await WebUsbTransport.fromDevice(device);
    expect(mock.open).toHaveBeenCalledOnce();
    expect(mock.claimInterface).toHaveBeenCalledWith(0);
    expect(mock.selectConfiguration).not.toHaveBeenCalled();
  });

  it('fromDevice() selects configuration 1 when device.configuration is null', async () => {
    const { mock, device } = makeDevice(null);
    const populated = makeConfiguration([
      { endpointNumber: 1, direction: 'out' },
      { endpointNumber: 2, direction: 'in' },
    ]);
    mock.selectConfiguration.mockImplementationOnce(() => {
      mock.configuration = populated;
      return Promise.resolve();
    });
    await WebUsbTransport.fromDevice(device);
    expect(mock.selectConfiguration).toHaveBeenCalledWith(1);
  });

  it('fromDevice() throws when interface 0 has no IN or OUT endpoint', async () => {
    const { device } = makeDevice(makeConfiguration([{ endpointNumber: 1, direction: 'out' }]));
    await expect(WebUsbTransport.fromDevice(device)).rejects.toThrow(/bulk IN or OUT/);
  });

  it('write() calls transferOut with the OUT endpoint and data', async () => {
    const { mock, device } = makeDevice();
    const transport = await WebUsbTransport.fromDevice(device);
    const payload = new Uint8Array([0x1b, 0x40]);
    await transport.write(payload);
    expect(mock.transferOut).toHaveBeenCalledWith(1, payload);
  });

  it('read() calls transferIn with the IN endpoint and returns a Uint8Array', async () => {
    const { mock, device } = makeDevice();
    const transport = await WebUsbTransport.fromDevice(device);
    const result = await transport.read(3);
    expect(mock.transferIn).toHaveBeenCalledWith(2, 3);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it('read() returns empty Uint8Array when transferIn resolves without data', async () => {
    const { mock, device } = makeDevice();
    mock.transferIn.mockResolvedValueOnce({ status: 'ok' });
    const transport = await WebUsbTransport.fromDevice(device);
    const result = await transport.read(10);
    expect(result.length).toBe(0);
  });

  it('read() with timeout rejects with TransportTimeoutError when transferIn never resolves', async () => {
    const { mock, device } = makeDevice();
    const neverResolves = new Promise<never>(() => {
      /* never settles */
    });
    mock.transferIn.mockImplementationOnce(() => neverResolves);
    const transport = await WebUsbTransport.fromDevice(device);
    vi.useFakeTimers();
    const promise = transport.read(4, 100);
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('write() after close() throws TransportClosedError', async () => {
    const { device } = makeDevice();
    const transport = await WebUsbTransport.fromDevice(device);
    await transport.close();
    await expect(transport.write(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('read() after close() throws TransportClosedError', async () => {
    const { device } = makeDevice();
    const transport = await WebUsbTransport.fromDevice(device);
    await transport.close();
    await expect(transport.read(1)).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('close() releases interface, closes device, and sets connected=false', async () => {
    const { mock, device } = makeDevice();
    const transport = await WebUsbTransport.fromDevice(device);
    await transport.close();
    expect(mock.releaseInterface).toHaveBeenCalledWith(0);
    expect(mock.close).toHaveBeenCalledOnce();
    expect(transport.connected).toBe(false);
  });

  it('close() is idempotent', async () => {
    const { mock, device } = makeDevice();
    const transport = await WebUsbTransport.fromDevice(device);
    await transport.close();
    await transport.close();
    expect(mock.releaseInterface).toHaveBeenCalledOnce();
    expect(mock.close).toHaveBeenCalledOnce();
  });
});
