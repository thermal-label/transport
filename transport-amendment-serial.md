# @thermal-label/transport — Amendment: Serial Transports

> Add `WebSerialTransport` (browser) and `SerialTransport` (Node.js) to the
> transport package. These cover Bluetooth SPP printers (like the Brother
> QL-820NWB) and USB-to-serial adapters.
>
> **Discovery:** the Brother QL-820NWB uses classic Bluetooth with SPP
> (Serial Port Profile), NOT Bluetooth Low Energy. The QL-820NWBc datasheet
> confirms: Bluetooth 5.2, profiles: SPP, OPP, HCRP. This means:
> - Web Bluetooth API (GATT) cannot reach it
> - Web Serial API (RFCOMM) CAN reach it — shipped in Chrome 117+ desktop,
>   coming to Android
> - On Node.js, it appears as `/dev/rfcomm0` after pairing via BlueZ
>
> The `WebBluetoothTransport` remains for actual BLE GATT printers (Niimbot,
> Phomemo). These serial transports are a separate concern.

---

## 1. What's Added

### 1.1 New Subpath

```json
{
  "exports": {
    ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" },
    "./node": { "import": "./dist/node/index.js", "types": "./dist/node/index.d.ts" },
    "./web": { "import": "./dist/web/index.js", "types": "./dist/web/index.d.ts" }
  }
}
```

No new subpath needed — serial transports are added to the existing
`/node` and `/web` subpaths.

### 1.2 New Files

```
src/
  node/
    serial.ts          NEW: SerialTransport (Node.js)
    index.ts           updated: export SerialTransport
  web/
    web-serial.ts      NEW: WebSerialTransport (browser)
    index.ts           updated: export WebSerialTransport
  __tests__/
    serial.test.ts     NEW
    web-serial.test.ts NEW
```

### 1.3 Updated TransportType in Contracts

`@thermal-label/contracts` needs a new transport type. Publish a patch:

```typescript
export type TransportType = 'usb' | 'tcp' | 'serial' | 'webusb' | 'web-serial' | 'web-bluetooth';
```

`'serial'` = Node.js serial port (physical or RFCOMM).
`'web-serial'` = Web Serial API (browser, covers both wired serial and BT SPP).

---

## 2. WebSerialTransport (Browser)

```typescript
import type { Transport } from '@thermal-label/contracts';

/**
 * Web Serial API transport for serial-connected printers.
 *
 * Covers two use cases:
 * - Bluetooth SPP printers (paired via OS, appear in Chrome serial picker)
 * - USB-to-serial adapter cables
 *
 * Chrome 117+ on desktop, coming to Chrome Android.
 * The printer must be paired at the OS level first for Bluetooth SPP.
 * The Web Serial picker then shows both wired and wireless serial ports.
 *
 * The print protocol over serial is identical to USB/TCP — same raster
 * commands, just a different pipe. The Transport interface abstracts this.
 */
export class WebSerialTransport implements Transport {
  private port: SerialPort;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private rxBuffer: Uint8Array[];
  private _connected = false;

  private constructor(port: SerialPort) { ... }

  get connected(): boolean { return this._connected; }

  /**
   * Request a serial port via the browser picker.
   * Paired Bluetooth SPP devices appear alongside wired serial ports.
   *
   * For standard SPP (UUID 0x1101) — no filter needed:
   *   const transport = await WebSerialTransport.request();
   *
   * For custom RFCOMM services — pass the service class ID:
   *   const transport = await WebSerialTransport.request({
   *     allowedBluetoothServiceClassIds: [myUuid],
   *   });
   */
  static async request(options?: SerialPortRequestOptions): Promise<WebSerialTransport>;

  /**
   * Wrap an already-obtained SerialPort.
   * Useful for ports from navigator.serial.getPorts() (previously paired).
   */
  static async fromPort(port: SerialPort, baudRate?: number): Promise<WebSerialTransport>;

  async write(data: Uint8Array): Promise<void> {
    // writer.write(data)
    // Web Serial handles chunking internally
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    // Read from the readable stream
    // Buffer incoming chunks until length bytes accumulated
    // Timeout via Promise.race
    // Throws TransportTimeoutError on timeout
  }

  async close(): Promise<void> {
    // reader.cancel(), writer.close(), port.close()
    // Idempotent
  }
}
```

**Open parameters:** `port.open({ baudRate })` is required by the API
but for Bluetooth SPP the baud rate is ignored (RFCOMM handles flow
control). Default to `9600`. For physical serial ports the baud rate
matters — allow it as a parameter.

**Read buffering:** Web Serial's readable stream delivers chunks of
varying size. Same buffering pattern as TCP and BLE — accumulate in
`rxBuffer`, return when enough bytes are available.

### 2.1 Usage — Brother QL-820NWB over Bluetooth

```typescript
import { WebSerialTransport } from '@thermal-label/transport/web';

// User pairs printer via OS Bluetooth settings first
// Then in the browser:
const transport = await WebSerialTransport.request();
// Picker shows "QL-820NWB9125" alongside any wired serial ports

// From here it's identical to USB/TCP — same raster commands
await transport.write(invalidateCommand);
await transport.write(initCommand);
await transport.write(mediaInfoCommand);
await transport.write(rasterData);

const status = await transport.read(32);
await transport.close();
```

---

## 3. SerialTransport (Node.js)

```typescript
import type { Transport } from '@thermal-label/contracts';

/**
 * Node.js serial port transport.
 *
 * Covers:
 * - Bluetooth SPP via /dev/rfcomm0 (Linux, after pairing + rfcomm bind)
 * - USB-to-serial adapters via /dev/ttyUSB0, /dev/ttyACM0, COM3, etc.
 *
 * Uses the 'serialport' npm package for cross-platform serial access.
 */
export class SerialTransport implements Transport {
  private port: import('serialport').SerialPort;
  private rxBuffer: Buffer;
  private _connected = false;

  private constructor(port: import('serialport').SerialPort) { ... }

  get connected(): boolean { return this._connected; }

  /**
   * Open a serial port by path.
   * @param path — e.g. '/dev/rfcomm0', '/dev/ttyUSB0', 'COM3'
   * @param baudRate — default 9600 (ignored for RFCOMM but required by API)
   */
  static async open(path: string, baudRate?: number): Promise<SerialTransport>;

  async write(data: Uint8Array): Promise<void> {
    // port.write(Buffer.from(data))
    // Wait for drain
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    // Accumulate from port 'data' events
    // Same buffering pattern as TcpTransport
    // Returns Uint8Array
  }

  async close(): Promise<void> {
    // port.close()
    // Idempotent
  }
}
```

### 3.1 Dependency

Add `serialport` as an optional peer dependency alongside `usb`:

```json
{
  "peerDependencies": {
    "usb": ">=2.14.0",
    "serialport": ">=12.0.0"
  },
  "peerDependenciesMeta": {
    "usb": { "optional": true },
    "serialport": { "optional": true }
  }
}
```

Consumers importing only `transport/web` need neither. Consumers using
`UsbTransport` need `usb`. Consumers using `SerialTransport` need
`serialport`. Both optional — install what you use.

### 3.2 Usage — Brother QL-820NWB over Bluetooth (Linux)

```bash
# Pair via bluetoothctl
bluetoothctl
  pair 44:F7:9F:48:C2:D6
  trust 44:F7:9F:48:C2:D6

# Bind to RFCOMM device
sudo rfcomm bind /dev/rfcomm0 44:F7:9F:48:C2:D6
```

```typescript
import { SerialTransport } from '@thermal-label/transport/node';

const transport = await SerialTransport.open('/dev/rfcomm0');
// Same raster commands as USB/TCP
await transport.write(printData);
const status = await transport.read(32);
await transport.close();
```

---

## 4. Impact on Existing Transport Package

### 4.1 Root Index

The root `src/index.ts` exports discovery helpers only — no change needed.
Serial transports are exported from their respective subpaths.

### 4.2 Discovery Helpers

Add a new helper for WebSerial filtering:

```typescript
/**
 * Build Web Serial request options that include Bluetooth SPP devices.
 * For standard SPP (most printers), no special options needed.
 * For custom RFCOMM services, pass allowedBluetoothServiceClassIds.
 */
export function buildSerialRequestOptions(
  bluetoothServiceClassIds?: string[],
): SerialPortRequestOptions;
```

### 4.3 Node Discovery

`SerialTransport` doesn't have auto-discovery like USB (no VID/PID to match).
Serial ports are opened by explicit path. The discovery flow is:

- **USB printers** → `listPrinters()` via VID/PID matching (existing)
- **TCP printers** → `openPrinter({ host })` by explicit IP (existing)
- **Serial printers** → `openPrinter({ serial: '/dev/rfcomm0' })` by explicit path

Worth extending `OpenOptions` in contracts:

```typescript
export interface OpenOptions {
  vid?: number;
  pid?: number;
  serialNumber?: string;
  host?: string;
  port?: number;
  serialPath?: string;  // NEW: /dev/rfcomm0, /dev/ttyUSB0, COM3
  baudRate?: number;     // NEW: default 9600
}
```

---

## 5. Impact on Brother QL Driver

The QL-820NWB's device descriptor updates:

```typescript
QL_820NWB: {
  name: 'QL-820NWB',
  vid: 0x04F9, pid: 0x20A7,
  family: 'brother-ql',
  transports: ['usb', 'tcp', 'serial', 'web-serial'],  // NOT 'web-bluetooth'
  // No bluetooth: BluetoothConfig — that's for BLE GATT, not SPP
},
```

The driver's node package adds `SerialTransport` as a transport option:

```typescript
// In BrotherQLDiscovery.openPrinter()
if (options?.serialPath) {
  const transport = await SerialTransport.open(options.serialPath, options.baudRate);
  return new BrotherQLPrinter(transport, device);
}
```

The print protocol is identical over serial — same raster commands as
USB and TCP. Only the transport pipe differs.

---

## 6. The Full Transport Picture

```
@thermal-label/transport/node
  UsbTransport              USB Printer Class (libusb)
  TcpTransport              TCP port 9100
  SerialTransport           Serial port (/dev/rfcomm0, /dev/ttyUSB0, COM3)

@thermal-label/transport/web
  WebUsbTransport           navigator.usb (USB Printer Class)
  WebSerialTransport        navigator.serial (BT SPP + USB serial adapters)
  WebBluetoothTransport     navigator.bluetooth (BLE GATT — Niimbot, Phomemo)
```

Each transport implements the same `Transport` interface. The driver
doesn't care which transport it's using — it writes bytes, reads bytes.
The consumer picks the transport based on how their printer is connected.

---

## 7. Tests

### 7.1 WebSerialTransport (`web-serial.test.ts`)

- Mock `navigator.serial` and `SerialPort`
- `request()` — calls `navigator.serial.requestPort` with correct options
- `request()` with bluetooth service class ID — passes to `allowedBluetoothServiceClassIds`
- `fromPort()` — opens port, gets reader/writer
- `write()` — calls `writer.write` with correct data
- `read()` — buffers chunks until enough bytes, returns `Uint8Array`
- `read()` — timeout throws `TransportTimeoutError`
- `close()` — cancels reader, closes writer, closes port
- `close()` — idempotent
- `connected` — tracks state

### 7.2 SerialTransport (`serial.test.ts`)

- Mock `serialport` module
- `open()` — creates port with correct path and baudRate
- `open()` — default baudRate 9600
- `write()` — calls `port.write` with Buffer, handles drain
- `read()` — accumulates from `data` events (same pattern as TCP)
- `read()` — timeout throws `TransportTimeoutError`
- `read()` — closed port throws `TransportClosedError`
- `close()` — calls `port.close()`
- `close()` — idempotent
- `connected` — tracks state

---

## 8. Implementation Checklist

```
□ Patch @thermal-label/contracts — add 'serial' and 'web-serial' to TransportType,
  add serialPath and baudRate to OpenOptions
□ src/web/web-serial.ts — WebSerialTransport
□ src/node/serial.ts — SerialTransport
□ Update src/web/index.ts — export WebSerialTransport
□ Update src/node/index.ts — export SerialTransport
□ Add buildSerialRequestOptions to discovery.ts
□ Add serialport to optional peer deps
□ src/__tests__/web-serial.test.ts
□ src/__tests__/serial.test.ts
□ Update README — document new transports with usage examples
□ Gate: typecheck + lint + test + build
□ Bump version, publish
```

---

## 9. Key Constraints

- **Web Serial API is Chrome/Edge only** — same as WebUSB. Firefox and
  Safari oppose it. Document this honestly.
- **Web Serial over Bluetooth requires OS-level pairing first.** The
  browser picker shows already-paired Bluetooth serial devices. The
  pairing happens in the OS Bluetooth settings, not in the browser.
- **`baudRate` is ignored for Bluetooth SPP** — RFCOMM handles flow
  control. The API requires it though, so default to 9600.
- **`serialport` is an optional peer dep** — only needed for Node.js
  serial transport. Browser consumers don't need it.
- **The print protocol is identical over serial.** Same raster commands
  as USB and TCP. Only the transport pipe differs. This is the entire
  point of the `Transport` interface abstraction.
- **`WebBluetoothTransport` is NOT replaced.** It stays for actual BLE
  GATT printers. Serial transports are a separate concern — classic
  Bluetooth SPP ≠ Bluetooth Low Energy GATT.