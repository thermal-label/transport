# @thermal-label/transport

[![npm version](https://img.shields.io/npm/v/@thermal-label/transport.svg)](https://www.npmjs.com/package/@thermal-label/transport)
[![CI](https://github.com/thermal-label/transport/actions/workflows/ci.yml/badge.svg)](https://github.com/thermal-label/transport/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

USB, TCP, Serial, WebUSB, Web Serial, and Web Bluetooth transport
classes for the `thermal-label` printer driver ecosystem. Every class
implements the `Transport` interface from
[`@thermal-label/contracts`][contracts], so drivers program against one
pull-based API regardless of the underlying channel.

## Install

```bash
pnpm add @thermal-label/transport
```

Node consumers that use `UsbTransport` also need the native `usb`
package, and consumers that use `SerialTransport` also need `serialport`:

```bash
pnpm add usb           # for UsbTransport
pnpm add serialport    # for SerialTransport
```

Both are declared as optional peer dependencies so browser-only consumers
never download them.

## What's in the box

| Export                            | Runtime | Purpose                                                                              |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `UsbTransport`                    | Node    | libusb bindings for USB Printer Class devices. Interface 0, bulk IN / OUT.           |
| `TcpTransport`                    | Node    | Raw TCP (port 9100 / JetDirect by default) with partial-read buffering.              |
| `SerialTransport`                 | Node    | `serialport` wrapper for `/dev/rfcomm*`, `/dev/ttyUSB*`, `COM<n>`.                   |
| `WebUsbTransport`                 | Browser | `navigator.usb` picker + `USBDevice` wrapper.                                        |
| `WebSerialTransport`              | Browser | `navigator.serial` picker + `SerialPort` wrapper (covers BT SPP + USB-serial).       |
| `WebBluetoothTransport`           | Browser | GATT transport for BLE printers (Niimbot, Phomemo, Brother BLE, …).                  |
| `matchDevice` / `buildUsbFilters` | Both    | Helpers for matching and requesting USB devices.                                     |
| `buildBluetoothRequestOptions`    | Both    | Build `navigator.bluetooth.requestDevice` options from a `BluetoothConfig`.          |
| `buildSerialRequestOptions`       | Both    | Build `navigator.serial.requestPort` options, optionally allow BT service class IDs. |
| `discoverAll`                     | Both    | Aggregate `PrinterDiscovery` implementations across drivers.                         |

## Subpath imports

Transport classes are split by runtime so browser bundlers never see the
`usb` native addon:

```ts
// Node.js
import { UsbTransport, TcpTransport, SerialTransport } from '@thermal-label/transport/node';

// Browser
import {
  WebUsbTransport,
  WebSerialTransport,
  WebBluetoothTransport,
} from '@thermal-label/transport/web';

// Platform-neutral discovery helpers
import { matchDevice, buildUsbFilters, discoverAll } from '@thermal-label/transport';
```

The root entry point (`@thermal-label/transport`) is safe to import from
either environment — it contains only discovery helpers.

## Usage

### UsbTransport (Node)

```ts
import { UsbTransport } from '@thermal-label/transport/node';

const transport = await UsbTransport.open(0x04f9, 0x209d); // Brother QL-820NWB
await transport.write(new Uint8Array([0x1b, 0x40])); // ESC @ (reset)
const status = await transport.read(32, 2000); // up to 32 bytes, 2s timeout
await transport.close();
```

`UsbTransport` opens the device, claims interface 0, detaches the
`usblp` kernel driver on Linux if present, and locates Bulk IN / OUT
endpoints. `read()` maps libusb timeouts to `TransportTimeoutError`.

### TcpTransport (Node)

```ts
import { TcpTransport } from '@thermal-label/transport/node';

const transport = await TcpTransport.connect('192.0.2.42'); // default port 9100
await transport.write(payload);
await transport.close();
```

`read(n)` accumulates bytes across `data` events and only resolves once
the buffer holds `n` bytes. Remainder bytes stay buffered for the next
call. Connection timeouts reject with `TransportError`; read timeouts
reject with `TransportTimeoutError`.

### SerialTransport (Node)

```ts
import { SerialTransport } from '@thermal-label/transport/node';

// Bluetooth SPP printer (Linux, after `bluetoothctl` pair + `rfcomm bind`)
const transport = await SerialTransport.open('/dev/rfcomm0');
await transport.write(payload);
const status = await transport.read(32, 2000);
await transport.close();

// USB-to-serial adapter — baud rate matters, default is 9600
const wired = await SerialTransport.open('/dev/ttyUSB0', 115200);
```

The same class covers Bluetooth SPP (`/dev/rfcomm*`, `COM<n>` after
Windows pairing), USB-to-serial adapters, and native UARTs. The
`baudRate` argument is forwarded to the OS driver; it is ignored for
RFCOMM links (flow control happens on the Bluetooth layer) but still
required by the `serialport` API, hence the 9600 default.

> **macOS:** classic Bluetooth SPP was removed from macOS years ago.
> Printers like the Brother QL-820NWB are reachable over serial on Linux
> and Windows only — macOS users should connect via USB or TCP instead.

### WebUsbTransport (Browser)

```ts
import { WebUsbTransport } from '@thermal-label/transport/web';
import { buildUsbFilters } from '@thermal-label/transport';
import { devices } from '@thermal-label/labelwriter'; // hypothetical driver registry

const filters = buildUsbFilters(devices);
const transport = await WebUsbTransport.request(filters);
```

`WebUsbTransport.request` shows the browser's USB picker.
`WebUsbTransport.fromDevice(device)` wraps a `USBDevice` obtained from
`navigator.usb.getDevices()` (previously paired devices).

### WebSerialTransport (Browser)

```ts
import { WebSerialTransport } from '@thermal-label/transport/web';

// Paired Bluetooth SPP printer appears alongside wired serial ports
const transport = await WebSerialTransport.request();
await transport.write(payload);
await transport.close();

// Wrap a previously-authorized port returned by navigator.serial.getPorts()
const [port] = await navigator.serial.getPorts();
const wrapped = await WebSerialTransport.fromPort(port, 115200);
```

`WebSerialTransport.fromPort` expects a port that is **not yet open** —
it calls `port.open({ baudRate })` internally. The browser picker lists
USB-serial adapters and any Bluetooth SPP devices already paired at the
OS level; Bluetooth pairing is not part of the Web Serial API and must
happen in OS settings first.

Chrome/Edge only on desktop (and Chrome Android). Firefox and Safari do
not implement Web Serial. Same macOS caveat as `SerialTransport`: no
classic Bluetooth SPP, so macOS users connect via USB or TCP instead.

### WebBluetoothTransport (Browser)

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

`write()` chunks data to `mtu` bytes (default 20) and sends sequentially
via `writeValueWithoutResponse`. `read(n)` buffers incoming
`characteristicvaluechanged` notifications and resolves once `n` bytes
are available.

### Discovery

```ts
import { discoverAll } from '@thermal-label/transport';
import { labelwriterDiscovery } from '@thermal-label/labelwriter';
import { brotherQlDiscovery } from '@thermal-label/brother-ql';

const printers = await discoverAll([labelwriterDiscovery, brotherQlDiscovery]);
```

`discoverAll` uses `Promise.allSettled`, so a failing driver does not
block discovery from the others.

## Contributing a new printer

For a full guide covering protocol reverse engineering, implementing
`PrinterAdapter` and `PrinterDiscovery`, BLE sniffing, and publishing a
driver package, see the [thermal-label contributing
guide][contributing].

## Reference drivers

These packages implement `PrinterAdapter` / `PrinterDiscovery` against
the transports in this package:

| Package                             | Printer family                       |
| ----------------------------------- | ------------------------------------ |
| [`@thermal-label/labelmanager`][lm] | DYMO LabelManager (thermal transfer) |
| [`@thermal-label/labelwriter`][lw]  | DYMO LabelWriter (direct thermal)    |
| [`@thermal-label/brother-ql`][bql]  | Brother QL series (direct thermal)   |

## Attribution

This project is not affiliated with DYMO, Brother, Niimbot, Phomemo, or
any other printer manufacturer. Trademarks belong to their respective
owners.

## License

MIT — see [`LICENSE`](./LICENSE).

[contracts]: https://github.com/thermal-label/contracts
[contributing]: https://github.com/thermal-label/.github/blob/main/CONTRIBUTING.md
[lm]: https://github.com/thermal-label/labelmanager
[lw]: https://github.com/thermal-label/labelwriter
[bql]: https://github.com/thermal-label/brother-ql
