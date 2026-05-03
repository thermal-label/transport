import { describe, expect, it, vi } from 'vitest';
import type {
  DeviceEntry,
  DiscoveredPrinter,
  PrinterAdapter,
  PrinterDiscovery,
} from '@thermal-label/contracts';
import {
  buildBluetoothRequestOptions,
  buildSerialRequestOptions,
  buildUsbFilters,
  discoverAll,
  matchDevice,
} from '../discovery.js';

const engine = { role: 'primary', protocol: 'test', dpi: 300, headDots: 672 } as const;

const brotherQL: DeviceEntry = {
  key: 'QL_820NWB',
  name: 'Brother QL-820NWB',
  family: 'brother-ql',
  transports: {
    usb: { vid: '0x04f9', pid: '0x209d' },
    tcp: { port: 9100 },
    'bluetooth-gatt': {
      serviceUuid: '0000ff00-0000-1000-8000-00805f9b34fb',
      txCharacteristicUuid: '0000ff02-0000-1000-8000-00805f9b34fb',
    },
  },
  engines: [engine],
  support: { status: 'untested' },
};
const labelwriter: DeviceEntry = {
  key: 'LW_550',
  name: 'DYMO LabelWriter 550',
  family: 'labelwriter',
  transports: { usb: { vid: '0x0922', pid: '0x0028' } },
  engines: [engine],
  support: { status: 'untested' },
};
const networkOnly: DeviceEntry = {
  key: 'NETWORK_ONLY',
  name: 'Network-only printer',
  family: 'generic-tcp',
  transports: { tcp: { port: 9100 } },
  engines: [engine],
  support: { status: 'untested' },
};

describe('matchDevice', () => {
  it('finds the matching entry for known VID/PID', () => {
    const match = matchDevice(0x04f9, 0x209d, [labelwriter, brotherQL]);
    expect(match).toBe(brotherQL);
  });

  it('returns undefined for unknown VID/PID', () => {
    expect(matchDevice(0xdead, 0xbeef, [brotherQL])).toBeUndefined();
  });

  it('skips entries without a usb transport', () => {
    expect(matchDevice(0x04f9, 0x209d, [networkOnly])).toBeUndefined();
  });
});

describe('buildUsbFilters', () => {
  it('produces a filter per USB-capable entry', () => {
    const filters = buildUsbFilters([brotherQL, labelwriter]);
    expect(filters).toEqual([
      { vendorId: 0x04f9, productId: 0x209d },
      { vendorId: 0x0922, productId: 0x0028 },
    ]);
  });

  it('skips entries without a usb transport', () => {
    const filters = buildUsbFilters([networkOnly, brotherQL]);
    expect(filters).toEqual([{ vendorId: 0x04f9, productId: 0x209d }]);
  });

  it('returns an empty array for no USB-capable entries', () => {
    expect(buildUsbFilters([networkOnly])).toEqual([]);
  });
});

describe('buildBluetoothRequestOptions', () => {
  it('maps serviceUuid into filters[].services and optionalServices', () => {
    const options = buildBluetoothRequestOptions({
      serviceUuid: '0000ff00-0000-1000-8000-00805f9b34fb',
      txCharacteristicUuid: '0000ff02-0000-1000-8000-00805f9b34fb',
    });
    expect(options).toEqual({
      filters: [{ services: ['0000ff00-0000-1000-8000-00805f9b34fb'] }],
      optionalServices: ['0000ff00-0000-1000-8000-00805f9b34fb'],
    });
  });

  it('includes namePrefix in the filter when present', () => {
    const options = buildBluetoothRequestOptions({
      serviceUuid: 'aaaa',
      txCharacteristicUuid: 'bbbb',
      namePrefix: 'QL-820',
    });
    expect(options).toEqual({
      filters: [{ namePrefix: 'QL-820', services: ['aaaa'] }],
      optionalServices: ['aaaa'],
    });
  });
});

describe('buildSerialRequestOptions', () => {
  it('returns an empty object when no service class IDs are provided', () => {
    expect(buildSerialRequestOptions()).toEqual({});
    expect(buildSerialRequestOptions([])).toEqual({});
  });

  it('maps service class IDs into allowedBluetoothServiceClassIds', () => {
    expect(buildSerialRequestOptions([0x1101, '0000abcd-0000-1000-8000-00805f9b34fb'])).toEqual({
      allowedBluetoothServiceClassIds: [0x1101, '0000abcd-0000-1000-8000-00805f9b34fb'],
    });
  });
});

describe('discoverAll', () => {
  function makeDiscovery(family: string, result: DiscoveredPrinter[] | Error): PrinterDiscovery {
    return {
      family,
      listPrinters: vi.fn(() =>
        result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
      ),
      openPrinter: vi.fn(() => Promise.resolve({} as PrinterAdapter)),
    };
  }

  const brotherPrinter: DiscoveredPrinter = {
    device: brotherQL,
    transport: 'usb',
    connectionId: 'usb:04f9:209d',
    serialNumber: 'ABC123',
  };
  const labelwriterPrinter: DiscoveredPrinter = {
    device: labelwriter,
    transport: 'usb',
    connectionId: 'usb:0922:0028',
  };

  it('combines results from multiple discoveries', async () => {
    const a = makeDiscovery('brother-ql', [brotherPrinter]);
    const b = makeDiscovery('labelwriter', [labelwriterPrinter]);
    const all = await discoverAll([a, b]);
    expect(all).toEqual([brotherPrinter, labelwriterPrinter]);
  });

  it('returns empty array when no discoveries are provided', async () => {
    const all = await discoverAll([]);
    expect(all).toEqual([]);
  });

  it('silently drops failing discoveries', async () => {
    const ok = makeDiscovery('brother-ql', [brotherPrinter]);
    const boom = makeDiscovery('labelwriter', new Error('backend offline'));
    const all = await discoverAll([ok, boom]);
    expect(all).toEqual([brotherPrinter]);
  });

  it('returns empty array when every discovery fails', async () => {
    const a = makeDiscovery('x', new Error('1'));
    const b = makeDiscovery('y', new Error('2'));
    const all = await discoverAll([a, b]);
    expect(all).toEqual([]);
  });
});
