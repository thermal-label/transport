# Class: WebSerialTransport

Web Serial API transport.

Covers two physical pipes that look the same to the browser:
- OS-paired Bluetooth SPP devices (e.g. Brother QL-820NWB on Linux
  after pairing via the OS Bluetooth settings, or on Windows after
  the same). macOS dropped classic Bluetooth SPP — no serial route
  there.
- USB-to-serial adapters.

Browser only — Web Serial is Chrome/Edge (desktop and Android). The
caller is responsible for pairing Bluetooth devices at the OS level
first; the browser picker then lists them alongside wired ports.

Read path: the `readable` stream delivers chunks of arbitrary size.
`read(n)` accumulates bytes until at least `n` are queued, matching
the pattern used by `TcpTransport` and `WebBluetoothTransport`.

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

### fromPort()

```ts
static fromPort(port: SerialPort, baudRate?: number): Promise<WebSerialTransport>;
```

Wrap an already-obtained `SerialPort` that is NOT yet open.

`fromPort` calls `port.open()` internally — pass the raw port
returned by `navigator.serial.getPorts()` (previously authorized
devices) or `navigator.serial.requestPort()`. Do not call
`port.open()` yourself first.

#### Parameters

| Parameter | Type | Default value |
| ------ | ------ | ------ |
| `port` | `SerialPort` | `undefined` |
| `baudRate` | `number` | `DEFAULT_BAUD_RATE` |

#### Returns

`Promise`\<`WebSerialTransport`\>

***

### request()

```ts
static request(options?: SerialPortRequestOptions, baudRate?: number): Promise<WebSerialTransport>;
```

Show the browser's serial-port picker and wrap the selected port.

Paired Bluetooth SPP devices appear alongside wired serial ports.
For ports exposing a custom RFCOMM service class, pass
`allowedBluetoothServiceClassIds` so the picker includes them —
ports with standard SPP (UUID `0x1101`) show up without a filter.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `options?` | `SerialPortRequestOptions` | `undefined` | Forwarded to `navigator.serial.requestPort`. |
| `baudRate?` | `number` | `DEFAULT_BAUD_RATE` | Default 9600. Ignored for Bluetooth SPP (RFCOMM handles flow control) but required by the Web Serial API. |

#### Returns

`Promise`\<`WebSerialTransport`\>
