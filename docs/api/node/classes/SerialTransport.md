# Class: SerialTransport

Node.js serial-port transport.

Covers three physical pipes that all look the same to userspace:
- Bluetooth SPP via `/dev/rfcomm0` (Linux, after `bluetoothctl` pair +
  `rfcomm bind`) or `COM<n>` (Windows, auto-assigned after pairing).
  macOS dropped classic Bluetooth SPP — no serial route there.
- USB-to-serial adapters via `/dev/ttyUSB0`, `/dev/ttyACM0`, `COM<n>`.
- Native UARTs on embedded boards.

Baud rate is forwarded to the OS driver. For RFCOMM it is ignored by
the underlying link (flow control is on the Bluetooth layer), but the
`serialport` API requires a value — default 9600.

Buffering pattern matches `TcpTransport`: incoming `data` events push
chunks into a `Buffer[]`, and `read(n)` resolves once enough bytes are
queued.

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

### open()

```ts
static open(path: string, baudRate?: number): Promise<SerialTransport>;
```

Open a serial port by path.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `path` | `string` | `undefined` | OS-specific device path (e.g. `/dev/rfcomm0`, `/dev/ttyUSB0`, `COM3`). |
| `baudRate` | `number` | `DEFAULT_BAUD_RATE` | Serial baud rate. Default 9600. Ignored for Bluetooth SPP but required by the `serialport` API. |

#### Returns

`Promise`\<`SerialTransport`\>
