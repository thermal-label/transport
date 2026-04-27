# @thermal-label/transport — Implementation Plan

> Concrete transport implementations for the thermal-label driver ecosystem.
> USB (libusb), TCP, WebUSB, and Web Bluetooth — all implementing the
> `Transport` interface from `@thermal-label/contracts`.
>
> Also includes discovery helpers and a reference to the contributor guide
> (hosted on the thermal-label GitHub org profile, not in this repo).
>
> **SCOPE: this plan covers ONLY the transport package.** Do not modify
> sibling driver packages. Those will be retrofitted separately.

---

## 1. Repository

`github.com/thermal-label/transport`

Single package with subpath exports for Node.js and browser environments.

```
transport/
├── .github/
│   ├── FUNDING.yml
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── src/
│   ├── index.ts              # re-exports everything
│   ├── node/
│   │   ├── index.ts
│   │   ├── usb.ts            # UsbTransport
│   │   └── tcp.ts            # TcpTransport
│   ├── web/
│   │   ├── index.ts
│   │   ├── webusb.ts         # WebUsbTransport
│   │   └── web-bluetooth.ts  # WebBluetoothTransport
│   ├── discovery.ts          # matchDevice, buildUsbFilters, discoverAll
│   └── __tests__/
│       ├── usb.test.ts
│       ├── tcp.test.ts
│       ├── webusb.test.ts
│       ├── web-bluetooth.test.ts
│       └── discovery.test.ts
├── PROGRESS.md
├── DECISIONS.md
├── BLOCKERS.md
├── LICENSE
├── README.md
├── package.json
├── tsconfig.json
├── tsconfig.build.json
└── eslint.config.js
```

---

## 2. Subpath Exports

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./node": {
      "import": "./dist/node/index.js",
      "types": "./dist/node/index.d.ts"
    },
    "./web": {
      "import": "./dist/web/index.js",
      "types": "./dist/web/index.d.ts"
    }
  }
}
```

- `@thermal-label/transport` — re-exports discovery helpers + everything
- `@thermal-label/transport/node` — `UsbTransport`, `TcpTransport`
- `@thermal-label/transport/web` — `WebUsbTransport`, `WebBluetoothTransport`

Browser consumers never see the `usb` native addon. Node consumers don't
pull in Web Bluetooth types. Clean separation.

---

## 3. Transport Implementations

All classes implement `Transport` from `@thermal-label/contracts`.

### 3.1 UsbTransport (Node.js)

```typescript
import type { Transport } from '@thermal-label/contracts';
import type { Device, Interface, InEndpoint, OutEndpoint } from 'usb';

export class UsbTransport implements Transport {
  private device: Device;
  private iface: Interface;
  private inEndpoint: InEndpoint;
  private outEndpoint: OutEndpoint;
  private _connected = false;

  private constructor(device: Device, iface: Interface,
    inEndpoint: InEndpoint, outEndpoint: OutEndpoint) { ... }

  get connected(): boolean { return this._connected; }

  /**
   * Open a USB Printer Class device by VID/PID.
   * - Finds the device via libusb enumeration
   * - Opens the device
   * - Claims interface 0 (Printer Class)
   * - Detaches kernel driver on Linux if attached (usblp)
   * - Locates Bulk IN and Bulk OUT endpoints
   */
  static async open(vid: number, pid: number): Promise<UsbTransport>;

  /**
   * Open by DeviceDescriptor — convenience wrapper.
   * Throws DeviceNotFoundError if vid/pid are undefined.
   */
  static async openDevice(descriptor: DeviceDescriptor): Promise<UsbTransport>;

  async write(data: Uint8Array): Promise<void> {
    // transferAsync on outEndpoint
    // data passed as Buffer.from(data) — libusb expects Buffer
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    // transferAsync on inEndpoint
    // Returns Uint8Array — convert from Buffer internally
    // Throws TransportTimeoutError on timeout
  }

  async close(): Promise<void> {
    // Release interface, close device
    // Idempotent — safe to call multiple times
    // Sets _connected = false
  }
}
```

**Lessons from driver implementations baked in:**
- Uses real `usb` package types — no wrapper interfaces, no `as unknown as`
- `read()` always returns `Uint8Array` (converts from `Buffer` internally)
- `close()` is async and idempotent
- Linux kernel driver detach is unconditional in `open()` — safe even if
  no kernel driver is attached
- Interface 0 assumed to be Printer Class — this covers all current printers
  (LabelManager, LabelWriter, Brother QL all use interface 0)

### 3.2 TcpTransport (Node.js)

```typescript
import type { Transport } from '@thermal-label/contracts';
import { Socket } from 'node:net';

export class TcpTransport implements Transport {
  private socket: Socket;
  private buffer: Buffer;
  private waitResolve: ((data: Buffer) => void) | null = null;
  private _connected = false;

  private constructor(socket: Socket) { ... }

  get connected(): boolean { return this._connected; }

  /**
   * Connect to a printer's raw TCP port.
   * @param host — IP address or hostname
   * @param port — default 9100
   * @param timeout — connection timeout in ms, default 5000
   */
  static async connect(host: string, port?: number, timeout?: number): Promise<TcpTransport>;

  async write(data: Uint8Array): Promise<void> {
    // socket.write wrapped in Promise
    // Waits for 'drain' event if socket buffer is full
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    // Accumulates from internal buffer until length bytes available
    // Incoming data arrives via socket 'data' event, appended to buffer
    // Returns Uint8Array when buffer has enough bytes
    // Throws TransportTimeoutError if timeout elapses before enough data
    // Throws TransportClosedError if socket closes mid-read
  }

  async close(): Promise<void> {
    // socket.end() + wait for 'close' event
    // Idempotent
  }
}
```

**Partial read handling:** TCP is a stream — `socket.on('data')` may
deliver 1 byte or 1000 bytes per callback. The internal buffer accumulates
all incoming data. `read(length)` checks the buffer first and only waits
if not enough bytes are available. This is the critical implementation
detail that all three existing drivers share.

### 3.3 WebUsbTransport (Browser)

```typescript
import type { Transport, DeviceDescriptor } from '@thermal-label/contracts';

export class WebUsbTransport implements Transport {
  private device: USBDevice;
  private interfaceNumber: number;
  private endpointOut: number;
  private endpointIn: number;
  private _connected = false;

  private constructor(device: USBDevice, interfaceNumber: number,
    endpointOut: number, endpointIn: number) { ... }

  get connected(): boolean { return this._connected; }

  /**
   * Request a printer via the browser USB picker.
   * @param filters — USB device filters (VID/PID pairs)
   */
  static async request(filters: USBDeviceFilter[]): Promise<WebUsbTransport>;

  /**
   * Wrap an already-selected USBDevice.
   * Useful when the device was obtained via navigator.usb.getDevices()
   * (previously paired devices) or passed from external code.
   */
  static async fromDevice(device: USBDevice): Promise<WebUsbTransport>;

  async write(data: Uint8Array): Promise<void> {
    // device.transferOut(endpointOut, data)
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    // device.transferIn(endpointIn, length)
    // Returns result.data as Uint8Array
    // Timeout via Promise.race with a setTimeout reject
  }

  async close(): Promise<void> {
    // device.releaseInterface(interfaceNumber)
    // device.close()
    // Idempotent
  }
}
```

**Endpoint discovery:** `fromDevice` and `request` both call an internal
`claimAndDiscover` method that:
1. Opens the device
2. Selects configuration 1
3. Claims interface 0 (Printer Class)
4. Finds the Bulk OUT and Bulk IN endpoints from the interface descriptor
5. Stores the endpoint numbers for `write`/`read`

### 3.4 WebBluetoothTransport (Browser only)

```typescript
import type { Transport, BluetoothConfig } from '@thermal-label/contracts';

/**
 * Web Bluetooth transport for BLE printers (Niimbot, Phomemo, Brother BLE, etc.).
 *
 * Browser only. Node.js BLE is out of scope for this package — see the
 * thermal-label contributing guide for the rationale.
 *
 * Web Bluetooth in Chrome/Edge handles platform pairing, GATT service
 * discovery, and MTU negotiation uniformly across platforms.
 */
export class WebBluetoothTransport implements Transport {
  private device: BluetoothDevice;
  private txCharacteristic: BluetoothRemoteGATTCharacteristic;
  private rxCharacteristic?: BluetoothRemoteGATTCharacteristic;
  private rxBuffer: Uint8Array[];
  private rxWaiting: {
    resolve: (data: Uint8Array) => void;
    reject: (err: Error) => void;
    needed: number;
  } | null = null;
  private mtu: number;
  private _connected = false;

  private constructor(...) { ... }

  get connected(): boolean { return this._connected; }

  /**
   * Request a BLE printer via the browser Bluetooth picker.
   * Uses BluetoothConfig from the device descriptor to filter and connect.
   */
  static async request(config: BluetoothConfig): Promise<WebBluetoothTransport>;

  async write(data: Uint8Array): Promise<void> {
    // Split data into MTU-sized chunks
    // Send each chunk via txCharacteristic.writeValueWithoutResponse()
    // Small delay between chunks if needed (some BLE printers need pacing)
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    // Check rxBuffer first — return immediately if enough bytes buffered
    // Otherwise wait for characteristicvaluechanged notifications to
    //   accumulate enough bytes
    // Throws TransportTimeoutError if timeout elapses
    // Throws TransportClosedError if device disconnects mid-read
  }

  async close(): Promise<void> {
    // Remove notification listener
    // device.gatt.disconnect()
    // Idempotent
  }
}
```

**Write chunking:** BLE has a maximum transmission unit. Default is 20
bytes but many printers negotiate larger (Brother QL-820NWB reportedly
supports 512). `write()` splits data into `mtu`-sized chunks and sends
sequentially. Callers send any size `Uint8Array` — chunking is internal.

**Read buffering:** BLE is notification-driven — there's no "read N bytes"
primitive. The transport listens for `characteristicvaluechanged` events
on the RX characteristic and appends each notification's value to `rxBuffer`.
When `read(length)` is called, it checks the buffer. If enough bytes are
available, it returns immediately. Otherwise it registers a waiter that
resolves when enough bytes accumulate.

**MTU discovery:** `request()` attempts MTU negotiation via
`server.getPrimaryService()` → `service.getCharacteristic()`. If the
device supports a larger MTU, use it. Otherwise fall back to the
`BluetoothConfig.mtu` value (default 20).

---

## 4. Discovery Helpers

```typescript
import type {
  DeviceDescriptor,
  DiscoveredPrinter,
  PrinterDiscovery,
  BluetoothConfig,
} from '@thermal-label/contracts';

/**
 * Match a USB device against a list of known device descriptors.
 */
export function matchDevice(
  vid: number,
  pid: number,
  registries: DeviceDescriptor[],
): DeviceDescriptor | undefined;

/**
 * Build WebUSB filters from device registries.
 * Only includes devices that have vid and pid defined.
 * Useful for navigator.usb.requestDevice({ filters }).
 */
export function buildUsbFilters(
  registries: DeviceDescriptor[],
): USBDeviceFilter[];

/**
 * Build Web Bluetooth request options from a BluetoothConfig.
 * Maps serviceUuid to requiredServices and namePrefix to filters.
 */
export function buildBluetoothRequestOptions(
  config: BluetoothConfig,
): RequestDeviceOptions;

/**
 * Universal printer discovery — tries all installed drivers.
 * Calls listPrinters() on each discovery implementation, combines results,
 * and returns the unified list.
 */
export async function discoverAll(
  discoveries: PrinterDiscovery[],
): Promise<DiscoveredPrinter[]>;
```

`buildUsbFilters` skips devices where `vid` or `pid` is undefined
(network-only printers). This is consistent with `DeviceDescriptor`
having optional VID/PID.

---

## 5. Package Setup

```json
{
  "name": "@thermal-label/transport",
  "version": "0.1.0",
  "description": "USB, TCP, WebUSB, and Web Bluetooth transport classes for thermal-label drivers",
  "keywords": ["thermal-label", "usb", "tcp", "webusb", "bluetooth", "transport", "printer"],
  "type": "module",
  "author": "Mannes Brak",
  "license": "MIT",
  "homepage": "https://github.com/thermal-label/transport",
  "repository": { "type": "git", "url": "https://github.com/thermal-label/transport.git" },
  "bugs": { "url": "https://github.com/thermal-label/transport/issues" },
  "funding": [
    { "type": "github", "url": "https://github.com/sponsors/mannes" },
    { "type": "ko-fi", "url": "https://ko-fi.com/mannes" }
  ],
  "files": ["dist", "README.md"],
  "engines": { "node": ">=24.0.0" },
  "publishConfig": { "access": "public" },
  "sideEffects": false,
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./node": { "import": "./dist/node/index.js", "types": "./dist/node/index.d.ts" },
    "./web": { "import": "./dist/web/index.js", "types": "./dist/web/index.d.ts" }
  },
  "dependencies": {
    "@thermal-label/contracts": "^0.1.0"
  },
  "peerDependencies": {
    "usb": ">=2.14.0"
  },
  "peerDependenciesMeta": {
    "usb": { "optional": true }
  },
  "devDependencies": {
    "@mbtech-nl/eslint-config": "^1.0.0",
    "@mbtech-nl/prettier-config": "^1.0.0",
    "@mbtech-nl/tsconfig": "^1.0.0",
    "@types/node": "^22.0.0",
    "@types/w3c-web-bluetooth": "^2.0.0",
    "@types/w3c-web-usb": "^1.0.0",
    "@vitest/coverage-v8": "^2.0.0",
    "eslint": "^9.0.0",
    "prettier": "^3.0.0",
    "typescript": "~5.5.0",
    "usb": "^2.14.0",
    "vitest": "^2.0.0"
  }
}
```

**`usb` is optional peer dep** — only needed by consumers importing
`@thermal-label/transport/node`. Browser-only consumers never see it.
Listed in `devDependencies` for development/testing.

**`engines.node: ">=24.0.0"`** — unlike contracts (pure types), transport
has real Node.js code (`net.Socket`, `Buffer`).

Two tsconfigs: `tsconfig.json` wide for lint, `tsconfig.build.json` narrow
for emit.

---

## 6. Tests

### 6.1 UsbTransport (`usb.test.ts`)

- Mock `usb` module with `vi.mock`
- `open()` — finds device by VID/PID, opens, claims interface 0, finds endpoints
- `open()` — detaches kernel driver on Linux (mock `process.platform`)
- `open()` — throws `DeviceNotFoundError` for unknown VID/PID
- `openDevice()` — throws `DeviceNotFoundError` when descriptor has no vid/pid
- `write()` — calls `transferAsync` on OUT endpoint with correct data
- `read()` — returns `Uint8Array` (not `Buffer`)
- `read()` — throws `TransportTimeoutError` on timeout
- `close()` — releases interface, closes device
- `close()` — idempotent, second call does nothing
- `connected` — true after open, false after close

### 6.2 TcpTransport (`tcp.test.ts`)

- Mock `net.Socket`
- `connect()` — creates socket, connects to host:port
- `connect()` — default port is 9100
- `connect()` — throws on connection timeout
- `write()` — calls `socket.write`, handles backpressure via drain
- `read(10)` — returns 10 bytes when socket delivers 10 at once
- `read(10)` — accumulates partial reads (5 + 5 bytes across two `data` events)
- `read()` — throws `TransportTimeoutError` on timeout
- `read()` — throws `TransportClosedError` if socket closes mid-read
- `close()` — calls `socket.end()`, waits for close
- `close()` — idempotent

### 6.3 WebUsbTransport (`webusb.test.ts`)

- Mock `USBDevice` with spy methods
- `request()` — calls `navigator.usb.requestDevice` with correct filters
- `fromDevice()` — opens, selects config, claims interface, finds endpoints
- `write()` — calls `device.transferOut` with correct endpoint and data
- `read()` — calls `device.transferIn`, returns `Uint8Array`
- `read()` — timeout via `Promise.race`
- `close()` — releases interface, closes device
- `close()` — idempotent
- `connected` — tracks state

### 6.4 WebBluetoothTransport (`web-bluetooth.test.ts`)

- Mock `BluetoothDevice`, GATT server, service, characteristics
- `request()` — calls `navigator.bluetooth.requestDevice` with correct
  service UUID and name filter from `BluetoothConfig`
- `request()` — connects to GATT, gets service, gets characteristics
- `request()` — starts notifications on RX characteristic
- `write()` — chunks data to MTU size, sends sequentially
- `write()` — single chunk when data < MTU
- `write()` — multiple chunks when data > MTU
- `read()` — returns immediately when buffer has enough bytes
- `read()` — waits for notifications when buffer is insufficient
- `read()` — accumulates across multiple notifications
- `read()` — throws `TransportTimeoutError` on timeout
- `read()` — throws `TransportClosedError` on disconnect
- `close()` — disconnects GATT
- `close()` — idempotent

### 6.5 Discovery (`discovery.test.ts`)

- `matchDevice` — finds correct descriptor for known VID/PID
- `matchDevice` — returns undefined for unknown VID/PID
- `matchDevice` — skips descriptors with undefined vid/pid
- `buildUsbFilters` — produces correct filter array
- `buildUsbFilters` — skips devices without vid/pid
- `buildBluetoothRequestOptions` — maps serviceUuid to requiredServices
- `buildBluetoothRequestOptions` — includes namePrefix filter when present
- `discoverAll` — combines results from multiple discoveries
- `discoverAll` — handles empty discoveries gracefully
- `discoverAll` — one failing discovery doesn't block others

---

## 7. README

- Package name + description
- Install: `pnpm add @thermal-label/transport`
- Subpath imports explained with examples:
  ```typescript
  import { UsbTransport, TcpTransport } from '@thermal-label/transport/node';
  import { WebUsbTransport, WebBluetoothTransport } from '@thermal-label/transport/web';
  ```
- Quick usage example per transport type
- Discovery helpers usage
- Note: "For transport interfaces and types, see `@thermal-label/contracts`"
- Note: "For a guide on adding support for a new printer, see the
  [thermal-label contributing guide](https://github.com/thermal-label/.github/blob/main/CONTRIBUTING.md)"
- Table of existing drivers as reference implementations
- Attribution: not affiliated with Dymo, Brother, etc.
- License badge, funding links

---

## 8. Contributor Guide Reference

The full contributing guide lives on the thermal-label GitHub org profile
at `github.com/thermal-label/.github/CONTRIBUTING.md`. This is an org-wide
doc covering the full process of adding a new printer driver.

**This repo's README links to it.** The transport package does NOT contain
the full guide — only a reference. This avoids duplicating prose across repos.

**TODO for later:** write the actual contributing guide on the org profile.
Not part of this implementation — tracked as a separate documentation task.
The guide should cover:
- Protocol reverse engineering methodology
- Creating a core package
- Using shared transports from this package
- Implementing PrinterAdapter and PrinterDiscovery from contracts
- BLE-specific guidance (GATT sniffing, nRF Connect, MTU negotiation)
- Publishing and registering with burnmark ecosystem

---

## 9. CI/CD

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v5
        with: { version: 9 }
      - uses: actions/setup-node@v6
        with: { node-version: '24', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm prettier --check "src/**/*.ts"
      - run: pnpm test:coverage
      - uses: codecov/codecov-action@v5
        with: { token: '${{ secrets.CODECOV_TOKEN }}' }
      - run: pnpm build
```

Release workflow: standard npm trusted publishing.

---

## 10. Implementation Sequence

```
1. Scaffold
   - LICENSE (MIT, Mannes Brak)
   - .github/FUNDING.yml
   - package.json, tsconfig.json, tsconfig.build.json, eslint.config.js
   - GitHub Actions: ci.yml, release.yml
   - .gitignore
   - PROGRESS.md, DECISIONS.md, BLOCKERS.md
   - pnpm install — must complete without errors
   - Commit + push

2. UsbTransport
   - src/node/usb.ts
   - src/__tests__/usb.test.ts
   - Gate: typecheck + lint + test + build
   - Commit + push

3. TcpTransport
   - src/node/tcp.ts
   - src/node/index.ts (export both)
   - src/__tests__/tcp.test.ts
   - Gate: typecheck + lint + test + build
   - Commit + push

4. WebUsbTransport
   - src/web/webusb.ts
   - src/__tests__/webusb.test.ts
   - Gate: typecheck + lint + test + build
   - Commit + push

5. WebBluetoothTransport
   - src/web/web-bluetooth.ts
   - src/web/index.ts (export both)
   - src/__tests__/web-bluetooth.test.ts
   - Gate: typecheck + lint + test + build
   - Commit + push

6. Discovery helpers
   - src/discovery.ts
   - src/__tests__/discovery.test.ts
   - Gate: typecheck + lint + test + build
   - Commit + push

7. Index and exports
   - src/index.ts — re-export everything
   - Verify all three subpath exports work
   - Gate: typecheck + lint + test + build
   - Commit + push

8. README
   - Complete, publish-ready per section 7
   - Commit + push

9. Final
   - pnpm test:coverage — verify thresholds
   - Verify all PROGRESS.md checkboxes ticked
   - Publish to npm
   - Commit + push
```

---

## 11. Key Constraints

**Scope:**
- **ONLY implement this package.** Do not modify sibling driver repos.
  Driver retrofits are separate work.
- The contributing guide content is NOT part of this implementation —
  just link to where it will live.

**Implementation:**
- All transport classes implement `Transport` from `@thermal-label/contracts`.
- Use real `usb` package types — no wrapper interfaces, no `as unknown as`.
- `read()` always returns `Uint8Array` — convert from `Buffer` internally.
- `close()` is always async and idempotent.
- Linux kernel driver detach in `UsbTransport.open()` — unconditional, safe.
- TCP partial read buffering — accumulate via `data` events, resolve when
  enough bytes available.
- BLE write chunking — split to MTU, send sequentially.
- BLE read buffering — accumulate notifications, resolve when enough bytes.
- `buildUsbFilters` skips devices with undefined vid/pid.
- `discoverAll` handles individual discovery failures gracefully — one
  failing driver doesn't block the rest.

**Tooling:**
- Two tsconfigs: wide for lint, narrow for emit.
- `usb` is optional peer dep — only for `/node` subpath.
- `@types/w3c-web-bluetooth` and `@types/w3c-web-usb` in devDependencies.
- `publishConfig: { access: "public" }`.
- `pnpm prettier --check` in CI.
- `sideEffects: false`.
- At 0.x, break freely.