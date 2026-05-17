# Class: UsbTransport

USB transport over libusb for Node.js.

Defaults to interface 0 — covering single-interface printer-class
devices used by `@thermal-label/*` drivers (LabelManager, LabelWriter,
Brother QL). Pass `{ bInterfaceNumber }` to claim a different
interface; this is needed for composite devices like the LabelWriter
450 Duo, which exposes one interface per engine.

Two transports may be opened against the same `(vid, pid)` device on
different interfaces; they share the underlying libusb handle via an
internal refcounted cache so that closing one does not invalidate the
other.

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
static open(
   vid: number, 
   pid: number, 
options?: UsbOpenOptions): Promise<UsbTransport>;
```

Open a USB Printer Class device by VID/PID.

Enumerates via libusb, opens (or refcount-acquires) the device,
claims the requested interface, detaches the `usblp` kernel driver
on Linux if attached, and locates Bulk IN / OUT endpoints on that
interface.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `vid` | `number` |
| `pid` | `number` |
| `options?` | [`UsbOpenOptions`](../interfaces/UsbOpenOptions.md) |

#### Returns

`Promise`\<`UsbTransport`\>

#### Throws

DeviceNotFoundError if no matching device is attached.

***

### openDevice()

```ts
static openDevice(entry: DeviceEntry, options?: UsbOpenOptions): Promise<UsbTransport>;
```

Convenience wrapper for opening a device from a `DeviceEntry`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `entry` | [`DeviceEntry`](/contracts/api/README) |
| `options?` | [`UsbOpenOptions`](../interfaces/UsbOpenOptions.md) |

#### Returns

`Promise`\<`UsbTransport`\>

#### Throws

DeviceNotFoundError if the entry has no `transports.usb`
  block (network-only printers cannot be opened over USB).
