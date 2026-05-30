import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DeviceEntry } from '@thermal-label/contracts';
import type * as DiscoveryModule from '../node/discovery.js';

type StringDescriptorCb = (err: Error | undefined, value?: string) => void;

interface MockDevice {
  deviceDescriptor: { idVendor: number; idProduct: number; iSerialNumber: number };
  busNumber: number;
  deviceAddress: number;
  open: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  getStringDescriptor: ReturnType<typeof vi.fn>;
}

const deviceList: MockDevice[] = [];

vi.mock('usb', () => ({
  getDeviceList: (): typeof deviceList => deviceList,
}));

async function load(): Promise<typeof DiscoveryModule> {
  return import('../node/discovery.js');
}

// Minimal registry entries — matchDevice only reads transports.usb.{vid,pid}.
function entry(key: string, vid: string, pid: string): DeviceEntry {
  return { key, transports: { usb: { vid, pid } } } as unknown as DeviceEntry;
}

const REGISTRY: DeviceEntry[] = [
  entry('PRINTER_A', '04f9', '2028'),
  entry('PRINTER_B', '0922', '1001'),
];

interface DeviceOpts {
  vid: number;
  pid: number;
  iSerialNumber?: number;
  bus?: number;
  addr?: number;
  serial?: string;
  openThrows?: boolean;
  serialErrors?: boolean;
  serialHangs?: boolean;
}

function makeDevice(o: DeviceOpts): MockDevice {
  return {
    deviceDescriptor: {
      idVendor: o.vid,
      idProduct: o.pid,
      iSerialNumber: o.iSerialNumber ?? 3,
    },
    busNumber: o.bus ?? 1,
    deviceAddress: o.addr ?? 5,
    open: vi.fn(() => {
      if (o.openThrows) throw new Error('LIBUSB_ERROR_ACCESS');
    }),
    close: vi.fn(),
    getStringDescriptor: vi.fn((_idx: number, cb: StringDescriptorCb) => {
      if (o.serialHangs) return; // never calls back
      if (o.serialErrors) cb(new Error('read failed'));
      else cb(undefined, o.serial ?? 'SN-DEFAULT');
    }),
  };
}

describe('enumerateUsbDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    deviceList.length = 0;
  });

  it('matches devices against the registry and skips unknown ones', async () => {
    deviceList.push(
      makeDevice({ vid: 0x04f9, pid: 0x2028, serial: 'AAA' }),
      makeDevice({ vid: 0xdead, pid: 0xbeef }), // not in registry
      makeDevice({ vid: 0x0922, pid: 0x1001, serial: 'BBB' }),
    );
    const { enumerateUsbDevices } = await load();
    const result = await enumerateUsbDevices(REGISTRY);
    expect(result.map(r => r.descriptor.key)).toEqual(['PRINTER_A', 'PRINTER_B']);
    expect(result.map(r => r.serialNumber)).toEqual(['AAA', 'BBB']);
  });

  it('treats a same-VID mass-storage decoy PID like any unknown device', async () => {
    // Same VID as PRINTER_A, but a PID absent from the registry (Editor-Lite
    // mass-storage mode) — matchDevice drops it, no special handling.
    deviceList.push(makeDevice({ vid: 0x04f9, pid: 0x9999 }));
    const { enumerateUsbDevices } = await load();
    expect(await enumerateUsbDevices(REGISTRY)).toEqual([]);
  });

  it('normalizes connectionId to `${bus}:${addr}`', async () => {
    deviceList.push(makeDevice({ vid: 0x04f9, pid: 0x2028, bus: 2, addr: 17 }));
    const { enumerateUsbDevices } = await load();
    const result = await enumerateUsbDevices(REGISTRY);
    expect(result[0]?.connectionId).toBe('2:17');
  });

  it('omits serialNumber and skips open when iSerialNumber is 0', async () => {
    const device = makeDevice({ vid: 0x04f9, pid: 0x2028, iSerialNumber: 0 });
    deviceList.push(device);
    const { enumerateUsbDevices } = await load();
    const result = await enumerateUsbDevices(REGISTRY);
    expect(result[0]?.serialNumber).toBeUndefined();
    expect(result[0] && 'serialNumber' in result[0]).toBe(false);
    expect(device.open).not.toHaveBeenCalled();
  });

  it('still lists a matched device whose open() throws, without a serial', async () => {
    deviceList.push(makeDevice({ vid: 0x04f9, pid: 0x2028, openThrows: true }));
    const { enumerateUsbDevices } = await load();
    const result = await enumerateUsbDevices(REGISTRY);
    expect(result[0]?.descriptor.key).toBe('PRINTER_A');
    expect(result[0]?.serialNumber).toBeUndefined();
  });

  it('still lists a matched device whose getStringDescriptor errors', async () => {
    deviceList.push(makeDevice({ vid: 0x04f9, pid: 0x2028, serialErrors: true }));
    const { enumerateUsbDevices } = await load();
    const result = await enumerateUsbDevices(REGISTRY);
    expect(result[0]?.serialNumber).toBeUndefined();
    expect(result[0]?.descriptor.key).toBe('PRINTER_A');
  });

  it('one bad device does not abort the scan for the rest', async () => {
    deviceList.push(
      makeDevice({ vid: 0x04f9, pid: 0x2028, openThrows: true }),
      makeDevice({ vid: 0x0922, pid: 0x1001, serial: 'GOOD' }),
    );
    const { enumerateUsbDevices } = await load();
    const result = await enumerateUsbDevices(REGISTRY);
    expect(result).toHaveLength(2);
    expect(result[1]?.serialNumber).toBe('GOOD');
    // bad device still listed, just without a serial
    expect(result[0]?.serialNumber).toBeUndefined();
  });

  // Real timers: a hung getStringDescriptor resolves via the internal
  // SERIAL_READ_TIMEOUT_MS (~1s). Fake timers can't drive this — the dynamic
  // `import('usb')` inside the helper resolves on a turn fake timers don't pump.
  it('times out (does not hang) when getStringDescriptor never calls back', async () => {
    deviceList.push(makeDevice({ vid: 0x04f9, pid: 0x2028, serialHangs: true }));
    const { enumerateUsbDevices } = await load();
    const result = await enumerateUsbDevices(REGISTRY);
    expect(result[0]?.serialNumber).toBeUndefined();
    expect(result[0]?.descriptor.key).toBe('PRINTER_A');
  }, 3_000);
});
