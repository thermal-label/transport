# Class: WebUsbTransport

WebUSB transport for browser environments.

Defaults to interface 0 — the same default as Node's `UsbTransport`.
Pass `{ interfaceNumber }` to claim a different interface; this is
needed for composite devices like the LabelWriter 450 Duo, which
exposes one interface per engine. Callers obtain a `USBDevice` via
`navigator.usb.requestDevice()` (prompts the user) or
`navigator.usb.getDevices()` (previously paired).

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

### fromDevice()

```ts
static fromDevice(device: USBDevice, options?: WebUsbOpenOptions): Promise<WebUsbTransport>;
```

Wrap an already-selected `USBDevice`.

Opens the device, selects the requested configuration if it is not
already active, claims the requested interface, and resolves the
bulk IN / OUT endpoint numbers from that interface descriptor. Use
this when the `USBDevice` came from `navigator.usb.getDevices()`
(previously paired devices) or from external code.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `device` | `USBDevice` |
| `options?` | [`WebUsbOpenOptions`](../interfaces/WebUsbOpenOptions.md) |

#### Returns

`Promise`\<`WebUsbTransport`\>

***

### request()

```ts
static request(filters: USBDeviceFilter[], options?: WebUsbOpenOptions): Promise<WebUsbTransport>;
```

Show the browser's USB picker and wrap the selected device.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `filters` | `USBDeviceFilter`[] | USB device filters (typically `{ vendorId, productId }` pairs built by `buildUsbFilters`). |
| `options?` | [`WebUsbOpenOptions`](../interfaces/WebUsbOpenOptions.md) | Optional interface/configuration selection. |

#### Returns

`Promise`\<`WebUsbTransport`\>
