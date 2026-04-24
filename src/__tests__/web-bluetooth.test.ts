import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TransportClosedError,
  TransportTimeoutError,
  type BluetoothConfig,
} from '@thermal-label/contracts';
import { WebBluetoothTransport } from '../web/web-bluetooth.js';

const SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';
const TX_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';
const RX_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';

interface CharacteristicMock {
  writeValueWithoutResponse: ReturnType<typeof vi.fn>;
  startNotifications: ReturnType<typeof vi.fn>;
  stopNotifications: ReturnType<typeof vi.fn>;
  listeners: ((event: Event) => void)[];
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
  fireValue(bytes: number[]): void;
  value?: DataView;
}

interface DeviceMock {
  listeners: (() => void)[];
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  fireDisconnect(): void;
  gatt: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    connected: boolean;
  };
}

function makeCharacteristic(): CharacteristicMock {
  const listeners: ((event: Event) => void)[] = [];
  const char: CharacteristicMock = {
    writeValueWithoutResponse: vi.fn(() => Promise.resolve()),
    startNotifications: vi.fn(() => Promise.resolve()),
    stopNotifications: vi.fn(() => Promise.resolve()),
    listeners,
    addEventListener(type, listener) {
      if (type === 'characteristicvaluechanged') listeners.push(listener);
    },
    removeEventListener(type, listener) {
      if (type !== 'characteristicvaluechanged') return;
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    fireValue(bytes) {
      char.value = new DataView(new Uint8Array(bytes).buffer);
      const event = { target: char } as unknown as Event;
      for (const listener of [...listeners]) listener(event);
    },
  };
  return char;
}

function makeDevice(): DeviceMock {
  const listeners: (() => void)[] = [];
  const gatt = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    connected: true,
  };
  const device: DeviceMock = {
    listeners,
    addEventListener(type, listener) {
      if (type === 'gattserverdisconnected') listeners.push(listener);
    },
    removeEventListener(type, listener) {
      if (type !== 'gattserverdisconnected') return;
      const idx = listeners.indexOf(listener);
      if (idx !== -1) listeners.splice(idx, 1);
    },
    fireDisconnect() {
      gatt.connected = false;
      for (const listener of [...listeners]) listener();
    },
    gatt,
  };
  return device;
}

async function setupTransport(overrides: Partial<BluetoothConfig> = {}): Promise<{
  transport: WebBluetoothTransport;
  device: DeviceMock;
  tx: CharacteristicMock;
  rx: CharacteristicMock;
  requestDevice: ReturnType<typeof vi.fn>;
}> {
  const tx = makeCharacteristic();
  const rx = overrides.rxCharacteristicUuid === undefined ? tx : makeCharacteristic();
  const device = makeDevice();
  const service = {
    getCharacteristic: vi.fn((uuid: string) => {
      if (uuid === TX_UUID) return Promise.resolve(tx);
      if (uuid === RX_UUID) return Promise.resolve(rx);
      return Promise.reject(new Error(`unknown char ${uuid}`));
    }),
  };
  const server = {
    getPrimaryService: vi.fn(() => Promise.resolve(service)),
  };
  device.gatt.connect.mockResolvedValue(server);

  const requestDevice = vi.fn().mockResolvedValue(device);
  vi.stubGlobal('navigator', { bluetooth: { requestDevice } });

  const config: BluetoothConfig = {
    serviceUuid: SERVICE_UUID,
    txCharacteristicUuid: TX_UUID,
    ...overrides,
  };
  const transport = await WebBluetoothTransport.request(config);
  return { transport, device, tx, rx, requestDevice };
}

describe('WebBluetoothTransport', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('request() calls navigator.bluetooth.requestDevice with service filter and optionalServices', async () => {
    const { requestDevice } = await setupTransport();
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
  });

  it('request() adds namePrefix to the filter when BluetoothConfig has one', async () => {
    const { requestDevice } = await setupTransport({ namePrefix: 'QL-820' });
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ namePrefix: 'QL-820', services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });
  });

  it('request() starts notifications on the RX characteristic', async () => {
    const { rx } = await setupTransport({ rxCharacteristicUuid: RX_UUID });
    expect(rx.startNotifications).toHaveBeenCalledOnce();
  });

  it('request() falls back to TX characteristic when rxCharacteristicUuid is omitted', async () => {
    const { tx } = await setupTransport();
    expect(tx.startNotifications).toHaveBeenCalledOnce();
  });

  it('request() throws when the selected device has no gatt', async () => {
    const device = makeDevice();
    (device as unknown as { gatt: unknown }).gatt = null;
    vi.stubGlobal('navigator', {
      bluetooth: { requestDevice: vi.fn().mockResolvedValue(device) },
    });
    await expect(
      WebBluetoothTransport.request({
        serviceUuid: SERVICE_UUID,
        txCharacteristicUuid: TX_UUID,
      }),
    ).rejects.toThrow(/no GATT server/);
  });

  it('write() sends a single chunk when data fits in one MTU', async () => {
    const { transport, tx } = await setupTransport({ mtu: 20 });
    await transport.write(new Uint8Array([1, 2, 3, 4]));
    expect(tx.writeValueWithoutResponse).toHaveBeenCalledOnce();
  });

  it('write() splits data into MTU-sized chunks', async () => {
    const { transport, tx } = await setupTransport({ mtu: 4 });
    await transport.write(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(tx.writeValueWithoutResponse).toHaveBeenCalledTimes(3);
    const chunks = tx.writeValueWithoutResponse.mock.calls.map(c => Array.from(c[0] as Uint8Array));
    expect(chunks).toEqual([[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
  });

  it('read() returns immediately when buffer already has enough bytes', async () => {
    const { transport, tx } = await setupTransport();
    tx.fireValue([10, 20, 30, 40, 50]);
    const result = await transport.read(3);
    expect(Array.from(result)).toEqual([10, 20, 30]);
  });

  it('read() leaves remainder in buffer for next call', async () => {
    const { transport, tx } = await setupTransport();
    tx.fireValue([1, 2, 3, 4, 5]);
    const first = await transport.read(2);
    expect(Array.from(first)).toEqual([1, 2]);
    const second = await transport.read(3);
    expect(Array.from(second)).toEqual([3, 4, 5]);
  });

  it('read() waits for notifications and accumulates across events', async () => {
    const { transport, tx } = await setupTransport();
    const promise = transport.read(5);
    tx.fireValue([1, 2]);
    tx.fireValue([3, 4, 5]);
    const result = await promise;
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('read() ignores notification events with no value', async () => {
    const { transport, tx } = await setupTransport();
    const promise = transport.read(2);
    // Manually fire an event with no value on the target
    const emptyTarget = { value: undefined } as unknown as EventTarget;
    for (const listener of [...tx.listeners]) listener({ target: emptyTarget } as unknown as Event);
    tx.fireValue([7, 8]);
    const result = await promise;
    expect(Array.from(result)).toEqual([7, 8]);
  });

  it('read() throws TransportTimeoutError when notifications do not arrive in time', async () => {
    const { transport } = await setupTransport();
    vi.useFakeTimers();
    const promise = transport.read(4, 100);
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toBeInstanceOf(TransportTimeoutError);
  });

  it('read() rejects with TransportClosedError when device disconnects mid-read', async () => {
    const { transport, device } = await setupTransport();
    const promise = transport.read(10);
    device.fireDisconnect();
    await expect(promise).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('read() on a closed transport throws TransportClosedError', async () => {
    const { transport } = await setupTransport();
    await transport.close();
    await expect(transport.read(1)).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('write() on a closed transport throws TransportClosedError', async () => {
    const { transport } = await setupTransport();
    await transport.close();
    await expect(transport.write(new Uint8Array([1]))).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('close() stops notifications, removes listeners, and disconnects GATT', async () => {
    const { transport, device, tx } = await setupTransport();
    await transport.close();
    expect(tx.stopNotifications).toHaveBeenCalledOnce();
    expect(device.gatt.disconnect).toHaveBeenCalledOnce();
    expect(transport.connected).toBe(false);
  });

  it('close() tolerates stopNotifications() rejecting (device already gone)', async () => {
    const { transport, tx } = await setupTransport();
    tx.stopNotifications.mockRejectedValueOnce(new Error('disconnected'));
    await expect(transport.close()).resolves.toBeUndefined();
    expect(transport.connected).toBe(false);
  });

  it('close() does not call gatt.disconnect when already disconnected', async () => {
    const { transport, device } = await setupTransport();
    device.gatt.connected = false;
    await transport.close();
    expect(device.gatt.disconnect).not.toHaveBeenCalled();
  });

  it('close() is idempotent', async () => {
    const { transport, tx } = await setupTransport();
    await transport.close();
    await transport.close();
    expect(tx.stopNotifications).toHaveBeenCalledOnce();
  });
});
