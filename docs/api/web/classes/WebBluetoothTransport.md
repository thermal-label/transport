# Class: WebBluetoothTransport

Web Bluetooth transport for BLE thermal label printers
(Niimbot, Phomemo, Brother BLE, etc.).

Browser only — Web Bluetooth in Chrome/Edge handles platform pairing,
GATT service discovery, and internal MTU negotiation uniformly across
platforms.

Write path: data is split into MTU-sized chunks and sent sequentially
via `writeValueWithoutResponse`, yielding to the event loop between
chunks so the browser can drain its write queue.

Read path: BLE has no "read N bytes" primitive, so this transport
listens for `characteristicvaluechanged` notifications on the RX
characteristic and accumulates them into a buffer. `read(n)` returns
from the buffer as soon as it holds at least `n` bytes.

## Implements

- [`Transport`](/contracts/api/interfaces/Transport)

## Accessors

### connected

#### Get Signature

```ts
get connected(): boolean;
```

Whether the transport is currently connected.

##### Returns

`boolean`

#### Implementation of

```ts
Transport.connected
```

## Methods

### close()

```ts
close(): Promise<void>;
```

Close the connection.

Always safe to call multiple times. Always `await` the result.

#### Returns

`Promise`\<`void`\>

#### Implementation of

```ts
Transport.close
```

***

### read()

```ts
read(length: number, timeout?: number): Promise<Uint8Array>;
```

Read bytes from the printer.

Buffers until `length` bytes are available or the timeout fires.

BLE implementations: there is no "read N bytes" primitive in BLE.
Implementations must buffer incoming GATT notifications internally
and satisfy `read()` calls from that buffer. Document this in your
transport class — every BLE implementation must handle buffering
consistently so drivers get the same pull-based API on every
transport.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `length` | `number` |
| `timeout?` | `number` |

#### Returns

`Promise`\<`Uint8Array`\>

#### Throws

TransportTimeoutError on timeout.

#### Throws

TransportClosedError if the transport is closed mid-read.

#### Implementation of

```ts
Transport.read
```

***

### write()

```ts
write(data: Uint8Array): Promise<void>;
```

Send bytes to the printer.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `Uint8Array` |

#### Returns

`Promise`\<`void`\>

#### Implementation of

```ts
Transport.write
```

***

### fromCharacteristics()

```ts
static fromCharacteristics(
   device: BluetoothDevice, 
   txCharacteristic: BluetoothRemoteGATTCharacteristic, 
   rxCharacteristic?: BluetoothRemoteGATTCharacteristic, 
   mtu?: number): WebBluetoothTransport;
```

Wrap a `BluetoothDevice` plus pre-resolved TX / RX characteristics.

Use when discovery cannot be expressed through the canonical-UUID
filter that `request()` assumes — for example, drivers that match
services by UUID prefix and derive the characteristic UUIDs from
the matched service's tail at runtime (e.g. DYMO LetraTag,
DECISIONS.md D4 in the letratag repo).

Caller is responsible for:
 - calling `device.gatt.connect()` and `getPrimaryService(...)`
 - resolving the TX and RX `BluetoothRemoteGATTCharacteristic`s
 - calling `rxCharacteristic.startNotifications()` before the first
   `read()` (the transport listens for `characteristicvaluechanged`
   events, but Web Bluetooth requires explicit notifications start)

If `rxCharacteristic` is omitted, `txCharacteristic` is used for both
directions (DECISIONS.md D6).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `device` | `BluetoothDevice` |
| `txCharacteristic` | `BluetoothRemoteGATTCharacteristic` |
| `rxCharacteristic?` | `BluetoothRemoteGATTCharacteristic` |
| `mtu?` | `number` |

#### Returns

`WebBluetoothTransport`

***

### request()

```ts
static request(config: BluetoothGattTransport): Promise<WebBluetoothTransport>;
```

Request a BLE printer via the browser Bluetooth picker.

Uses `BluetoothGattTransport` from the device descriptor to filter the
picker and resolve the TX / RX characteristics on the primary GATT
service. If `rxCharacteristicUuid` is omitted, the TX characteristic
is used for both directions (DECISIONS.md D6).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`BluetoothGattTransport`](/contracts/api/interfaces/BluetoothGattTransport) |

#### Returns

`Promise`\<`WebBluetoothTransport`\>
