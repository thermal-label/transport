# @thermal-label/transport

USB, TCP, Serial, WebUSB, Web Serial, and Web Bluetooth transport classes for
the **thermal-label** ecosystem. Every class implements `Transport` from
[`@thermal-label/contracts`](/contracts/), so drivers program against one
pull-based API regardless of the underlying channel.

## Install

```bash
pnpm add @thermal-label/transport
```

Native peers are optional — install only what your code path needs:

```bash
pnpm add usb           # for UsbTransport (Node)
pnpm add serialport    # for SerialTransport (Node)
```

Browser-only consumers download neither.

## What's in the box

| Export | Runtime | Purpose |
|---|---|---|
| `UsbTransport` | Node | libusb bindings for USB Printer Class devices. Interface 0 by default; `bInterfaceNumber` opt-in for composite devices. |
| `TcpTransport` | Node | Raw TCP (port 9100 / JetDirect by default) with partial-read buffering. |
| `SerialTransport` | Node | `serialport` wrapper for `/dev/rfcomm*`, `/dev/ttyUSB*`, `COM<n>`. |
| `WebUsbTransport` | Browser | `navigator.usb` picker + `USBDevice` wrapper. |
| `WebSerialTransport` | Browser | `navigator.serial` picker + `SerialPort` wrapper (covers BT SPP + USB-serial). |
| `WebBluetoothTransport` | Browser | GATT transport for BLE printers (Niimbot, Phomemo, Brother BLE, …). |
| `matchDevice` / `buildUsbFilters` | Both | Helpers for matching and requesting USB devices. |
| `buildBluetoothRequestOptions` | Both | Build `navigator.bluetooth.requestDevice` options from a `BluetoothConfig`. |
| `buildSerialRequestOptions` | Both | Build `navigator.serial.requestPort` options. |
| `discoverAll` | Both | Aggregate `PrinterDiscovery` implementations across drivers. |

## Subpath imports

Transport classes are split by runtime so browser bundlers never see the
`usb` native addon:

```ts
// Node
import { UsbTransport, TcpTransport, SerialTransport } from '@thermal-label/transport/node';

// Browser
import {
  WebUsbTransport,
  WebSerialTransport,
  WebBluetoothTransport,
} from '@thermal-label/transport/web';

// Platform-neutral helpers
import { matchDevice, buildUsbFilters, discoverAll } from '@thermal-label/transport';
```

The root entry (`@thermal-label/transport`) is safe to import from either
environment — it contains only discovery helpers.

## Examples

### `UsbTransport` (Node)

```ts
import { UsbTransport } from '@thermal-label/transport/node';

const transport = await UsbTransport.open(0x04f9, 0x209d); // Brother QL-820NWB
await transport.write(new Uint8Array([0x1b, 0x40]));       // ESC @ (reset)
const status = await transport.read(32, 2000);              // up to 32 bytes, 2s timeout
await transport.close();
```

Opens the device, claims interface 0, detaches the `usblp` kernel driver on
Linux when present, and locates Bulk IN / OUT endpoints. `read()` maps libusb
timeouts to `TransportTimeoutError`.

#### Composite devices (interface selection)

For composite USB devices that expose more than one printer-class interface
behind a single VID/PID — the LabelWriter 450 Duo is the canonical case —
pass `bInterfaceNumber` to claim a specific interface. Two transports against
the same `(vid, pid)` share the underlying libusb handle via an internal
refcount, so they can coexist and close independently.

```ts
const label = await UsbTransport.open(0x0922, 0x1003, { bInterfaceNumber: 0 });
const tape  = await UsbTransport.open(0x0922, 0x1003, { bInterfaceNumber: 1 });
// …
await label.close();   // releases interface 0; libusb handle stays open
await tape.close();    // releases interface 1; libusb handle closes
```

`UsbTransport.openDevice(descriptor, { bInterfaceNumber })` accepts the same
option. `WebUsbTransport.fromDevice(device, { interfaceNumber })` is the
browser-side equivalent.

### `TcpTransport` (Node)

```ts
import { TcpTransport } from '@thermal-label/transport/node';

const transport = await TcpTransport.connect('192.0.2.42'); // default port 9100
await transport.write(payload);
await transport.close();
```

`read(n)` accumulates bytes across `data` events and only resolves once the
buffer holds `n` bytes. Remainder bytes stay buffered for the next call.

### `SerialTransport` (Node)

```ts
import { SerialTransport } from '@thermal-label/transport/node';

// Bluetooth SPP printer (Linux, after `bluetoothctl pair` + `rfcomm bind`)
const transport = await SerialTransport.open('/dev/rfcomm0');
await transport.write(payload);

// USB-to-serial — baud rate matters
const wired = await SerialTransport.open('/dev/ttyUSB0', 115200);
```

> **macOS:** classic Bluetooth SPP was removed years ago. macOS users connect
> via USB or TCP instead.

### `WebUsbTransport` (Browser)

```ts
import { WebUsbTransport } from '@thermal-label/transport/web';
import { buildUsbFilters } from '@thermal-label/transport';
import { DEVICES } from '@thermal-label/labelwriter-web';

const filters = buildUsbFilters(DEVICES);
const transport = await WebUsbTransport.request(filters);
```

`WebUsbTransport.fromDevice(device)` wraps a `USBDevice` from
`navigator.usb.getDevices()` for previously-paired devices.

### `WebSerialTransport` (Browser)

```ts
import { WebSerialTransport } from '@thermal-label/transport/web';

const transport = await WebSerialTransport.request();
await transport.write(payload);
```

Chrome/Edge desktop and Chrome Android only. Firefox and Safari do not
implement Web Serial. The browser picker lists USB-serial adapters and any
Bluetooth SPP devices already paired at the OS level.

### `WebBluetoothTransport` (Browser)

```ts
import { WebBluetoothTransport } from '@thermal-label/transport/web';

const transport = await WebBluetoothTransport.request({
  serviceUuid: '0000ff00-0000-1000-8000-00805f9b34fb',
  txCharacteristicUuid: '0000ff02-0000-1000-8000-00805f9b34fb',
  rxCharacteristicUuid: '0000ff01-0000-1000-8000-00805f9b34fb',
  namePrefix: 'QL-820',
  mtu: 512,
});
```

`write()` chunks data to `mtu` bytes (default 20) and sends sequentially via
`writeValueWithoutResponse`. `read(n)` buffers incoming
`characteristicvaluechanged` notifications and resolves once `n` bytes are
available.

### Discovery aggregation

```ts
import { discoverAll } from '@thermal-label/transport';
import { discovery as labelwriter } from '@thermal-label/labelwriter-node';
import { discovery as brotherQl } from '@thermal-label/brother-ql-node';

const printers = await discoverAll([labelwriter, brotherQl]);
```

`discoverAll` uses `Promise.allSettled`, so a failing driver does not block
discovery from the others.

## Compatibility

| | |
|---|---|
| Node | ≥ 24 (for `UsbTransport`, `TcpTransport`, `SerialTransport`) |
| Browsers | Chrome/Edge 89+ (WebUSB, WebSerial); Web Bluetooth on Chrome/Edge desktop and Chrome Android |
| Optional peers | `usb` (Node USB), `serialport` (Node Serial) |
| License | MIT |

[Source on GitHub](https://github.com/thermal-label/transport) ·
[npm](https://www.npmjs.com/package/@thermal-label/transport)
