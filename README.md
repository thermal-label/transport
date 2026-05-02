# @thermal-label/transport

> USB, TCP, Serial, WebUSB, Web Serial, and Web Bluetooth transport classes for the thermal-label ecosystem.

[![npm version](https://img.shields.io/npm/v/@thermal-label/transport.svg)](https://www.npmjs.com/package/@thermal-label/transport)
[![CI](https://github.com/thermal-label/transport/actions/workflows/ci.yml/badge.svg)](https://github.com/thermal-label/transport/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Install

```bash
pnpm add @thermal-label/transport
pnpm add usb           # optional peer for UsbTransport (Node)
pnpm add serialport    # optional peer for SerialTransport (Node)
```

Browser-only consumers download neither native peer.

## Quick example (Node USB)

```ts
import { UsbTransport } from '@thermal-label/transport/node';

const transport = await UsbTransport.open(0x04f9, 0x209d); // Brother QL-820NWB
await transport.write(new Uint8Array([0x1b, 0x40]));        // ESC @ (reset)
const status = await transport.read(32, 2000);              // up to 32 bytes, 2s timeout
await transport.close();
```

## Quick example (Browser WebUSB)

```ts
import { WebUsbTransport } from '@thermal-label/transport/web';
import { buildUsbFilters } from '@thermal-label/transport';
import { DEVICES } from '@thermal-label/labelwriter-web';

const transport = await WebUsbTransport.request(buildUsbFilters(DEVICES));
```

## Documentation

Full docs at **<https://thermal-label.github.io/transport/>**.

- Per-transport reference: `UsbTransport`, `TcpTransport`, `SerialTransport`,
  `WebUsbTransport`, `WebSerialTransport`, `WebBluetoothTransport`
- Subpath imports — keep native USB out of browser bundles
- `discoverAll` — aggregate `PrinterDiscovery` across drivers

## Compatibility

| | |
|---|---|
| Node | ≥ 20.9 (Node 24 LTS recommended) — for `UsbTransport`, `TcpTransport`, `SerialTransport` |
| Browsers | Chrome / Edge 89+ (WebUSB, Web Serial); Web Bluetooth on Chrome / Edge desktop and Chrome Android |
| Optional peers | `usb` (Node USB), `serialport` (Node Serial) |
| Peer | `@thermal-label/contracts` |
| License | MIT |

## Contributing

See [`CONTRIBUTING/`](https://github.com/thermal-label/.github/tree/main/CONTRIBUTING)
on the org `.github` repo.
