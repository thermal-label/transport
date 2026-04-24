import { describe, expect, it, vi } from 'vitest';
import type {
  DeviceDescriptor,
  DiscoveredPrinter,
  PrinterAdapter,
  PrinterDiscovery,
} from '@thermal-label/contracts';
import {
  buildBluetoothRequestOptions,
  buildUsbFilters,
  discoverAll,
  matchDevice,
} from '../discovery.js';

const brotherQL: DeviceDescriptor = {
  name: 'Brother QL-820NWB',
  family: 'brother-ql',
  transports: ['usb', 'tcp', 'web-bluetooth'],
  vid: 0x04f9,
  pid: 0x209d,
};
const labelwriter: DeviceDescriptor = {
  name: 'DYMO LabelWriter 550',
  family: 'labelwriter',
  transports: ['usb'],
  vid: 0x0922,
  pid: 0x0028,
};
const networkOnly: DeviceDescriptor = {
  name: 'Network-only printer',
  family: 'generic-tcp',
  transports: ['tcp'],
};

describe('matchDevice', () => {
  it('finds the matching descriptor for known VID/PID', () => {
    const match = matchDevice(0x04f9, 0x209d, [labelwriter, brotherQL]);
    expect(match).toBe(brotherQL);
  });

  it('returns undefined for unknown VID/PID', () => {
    expect(matchDevice(0xdead, 0xbeef, [brotherQL])).toBeUndefined();
  });

  it('skips descriptors with undefined vid or pid', () => {
    expect(matchDevice(0x04f9, 0x209d, [networkOnly])).toBeUndefined();
  });
});

describe('buildUsbFilters', () => {
  it('produces a filter per USB-capable descriptor', () => {
    const filters = buildUsbFilters([brotherQL, labelwriter]);
    expect(filters).toEqual([
      { vendorId: 0x04f9, productId: 0x209d },
      { vendorId: 0x0922, productId: 0x0028 },
    ]);
  });

  it('skips descriptors without vid or pid', () => {
    const filters = buildUsbFilters([networkOnly, brotherQL]);
    expect(filters).toEqual([{ vendorId: 0x04f9, productId: 0x209d }]);
  });

  it('returns an empty array for no USB-capable descriptors', () => {
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
