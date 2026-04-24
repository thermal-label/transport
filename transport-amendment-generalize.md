# @thermal-label/transport — Amendment: Generalize to `@<scope>/transport`

> Speculative / not scheduled. Captures the thinking from a side
> conversation about whether this package is actually thermal-label-
> specific or whether the same code could serve LXI SCPI instruments,
> USB-MIDI controllers, barcode scanners, and other byte-stream peripherals.
>
> **Premise:** the six transport classes here are about moving bytes, not
> about labels. Most of them already make zero printer assumptions. The
> ones that do (USB interface 0, bulk endpoints, `usblp` detach) are a
> handful of lines. The name and README are the loudest printer signal
> in the package — the code is mostly innocent.
>
> This document captures what a generalization would look like, how much
> work it is, and what breaks for current consumers. Implement later or
> never — the artifact exists so the decision can be made with the
> details in front of us instead of from memory.

---

## 1. What's Already Generic

The following already make zero printer assumptions and would need only
docstring tweaks:

| File | Why it's generic |
| --- | --- |
| [src/node/tcp.ts](src/node/tcp.ts) | Raw TCP. Port 9100 is a _default_, not a hardcode — LXI SCPI on 5025 works via the `port` arg today. |
| [src/node/serial.ts](src/node/serial.ts) | No printer assumptions. `/dev/rfcomm*`, `/dev/ttyUSB*`, `COM<n>` — barcode scanners over SPP, MIDI over serial, SCPI over RS-232 all fit. |
| [src/web/web-serial.ts](src/web/web-serial.ts) | Same — Web Serial is a byte pipe. |
| [src/web/web-bluetooth.ts](src/web/web-bluetooth.ts) | GATT with TX/RX characteristics is the _generic_ BLE pattern (Niimbot, Phomemo, a heart-rate monitor, a custom fitness sensor — all fit). |
| [contracts/src/transport.ts](../contracts/src/transport.ts) | `Transport` — `write / read / close / connected`. Nothing printer-shaped. |
| [contracts/src/errors.ts](../contracts/src/errors.ts) | `TransportError`, `TransportClosedError`, `TransportTimeoutError` — generic. |

Minor cleanups only: drop "thermal label printer" references from
JSDoc, soften `TransportTimeoutError`'s "Read timed out waiting for
bytes from the printer" message to just "Read timed out."

## 2. What's Printer-Specific

### 2.1 USB (both Node and Web)

[src/node/usb.ts:19](src/node/usb.ts#L19) and
[src/web/webusb.ts:7-8](src/web/webusb.ts#L7-L8) hardcode:

```typescript
const INTERFACE_NUMBER = 0;
const CONFIGURATION_VALUE = 1;
// ... then find any bulk IN / any bulk OUT endpoint
```

This is the USB Printer Class convention. Other device classes:

| Class | Device | What changes |
| --- | --- | --- |
| Printer (7) | Thermal printers | Interface 0, bulk IN + OUT — matches current code |
| USBTMC (254, sub 3) | LXI SCPI via USB | Interface varies, bulk IN + OUT + interrupt IN, control transfers for `GET_CAPABILITIES`, `READ_STATUS_BYTE` |
| Audio (1) / MIDI (sub 3) | USB MIDI | Usually interface 1, bulk IN + OUT, message framing on top |
| HID (3) | Barcode scanners (most) | Interface varies, interrupt endpoints, report ID framing |

USBTMC is the closest fit — same endpoint shape, just different interface
number and an extra interrupt endpoint for status. HID is its own
universe (interrupt transfers, reports, not bulk) and doesn't belong
on top of `UsbTransport` — it needs a separate `HidTransport`.

### 2.2 The `usblp` Detach

[src/node/usb.ts:73-75](src/node/usb.ts#L73-L75) runs
`iface.detachKernelDriver()` on Linux when `usblp` has auto-claimed a
printer-class interface. This only fires on Linux and only matters for
printer-class devices. For a SCPI instrument it's a no-op (the kernel
has no USBTMC driver auto-grabbing it), for MIDI it's wrong
(`snd-usb-audio` is the right owner and detaching breaks ALSA's view),
for HID it's actively harmful (`usbhid` owns scanners and you don't
want to steal them from the input subsystem).

Needs to become opt-in: `{ detachKernelDriver?: boolean | string }`.

### 2.3 Naming and Positioning

Package name, README, keywords, and "thermal-label" prefix throughout.
The code underneath is mostly neutral; the wrapper says "printers only."

## 3. What's Domain-Specific (Stays in `@thermal-label/contracts`)

These have no business in a generic transport package and would stay
behind in a printer-focused contracts package:

- [contracts/src/adapter.ts](../contracts/src/adapter.ts) — `PrinterAdapter`
- [contracts/src/media.ts](../contracts/src/media.ts) — `MediaDescriptor`
- [contracts/src/preview.ts](../contracts/src/preview.ts) — `PreviewResult`, `PreviewOptions`
- [contracts/src/status.ts](../contracts/src/status.ts) — `PrinterStatus`, `PrintOptions`, `PrinterError`
- [contracts/src/discovery.ts](../contracts/src/discovery.ts) — `PrinterDiscovery`, `DiscoveredPrinter`, `OpenOptions`
- [contracts/src/bitmap.ts](../contracts/src/bitmap.ts) — `LabelBitmap`, `RawImageData`
- [contracts/src/errors.ts](../contracts/src/errors.ts) — `MediaNotSpecifiedError`, `UnsupportedOperationError`

The printer-ness of this project lives almost entirely in contracts,
not in transport.

### 3.1 `DeviceDescriptor` and `BluetoothConfig` — Dual-Use

Both are _shaped_ generically but are currently consumed only by
printer drivers. Options:

- **Leave in printer contracts** — drivers keep using them, the generic
  transport package doesn't export them, non-printer consumers invent
  their own descriptor type.
- **Lift to transport-core** — both describe a physical device, not a
  printer specifically. `BluetoothConfig` is just "how to talk to this
  BLE peripheral."

Probably lift. `DeviceDescriptor` with `family: string` is already
generic — it just happens to be populated by printer registries today.

### 3.2 `DeviceNotFoundError`

[contracts/src/errors.ts:47-56](../contracts/src/errors.ts#L47-L56) is
USB-centric (`vid?`, `pid?`). For a generic package it should accept
any filter shape (an `unknown`-typed `filter` property, or just a
message). Minor refactor.

## 4. Transports That Would Be Net-New

These aren't generalizations of what exists — they're new classes.
Listing them so the scope is explicit:

| Transport | Runtime | Use case | Difficulty |
| --- | --- | --- | --- |
| `HidTransport` | Node (`node-hid`) | Barcode scanners, game controllers | Medium — report IDs, interrupt endpoints, different API shape |
| `WebHidTransport` | Browser (`navigator.hid`) | Same, in browser | Medium — similar |
| `UsbtmcTransport` | Node | LXI SCPI over USB | Medium — USBTMC framing on top of bulk |
| `WebMidiTransport` | Browser (`navigator.requestMIDIAccess`) | USB MIDI controllers | Awkward — push-based event model, `read(n)` doesn't cleanly fit. May need a different interface variant or an event-emitter adapter |
| `VisaTransport` | Node | Full LXI (VXI-11, HiSLIP) | Hard — network protocol on top of TCP, session management |

`WebMidiTransport` is the one to think about hardest. Web MIDI is
`MIDIMessageEvent`-driven — you subscribe and messages arrive. Cramming
that into `read(length, timeout)` means either buffering raw bytes (fine
for sysex, weird for note-on/note-off) or changing the contract. Possibly
a separate `MessageTransport<T>` interface is cleaner for message-shaped
protocols.

## 5. Package Shape Options

### 5.1 Option A: Rename This Package

One-line summary: s/thermal-label/<scope>/ throughout, generalize USB,
done.

- Package becomes `@<scope>/transport`.
- `@thermal-label/contracts` keeps `Transport`, `TransportType`,
  errors, `BluetoothConfig`, `DeviceDescriptor` — or depends on
  `@<scope>/transport` for those types.
- Printer drivers import printer-specific things from
  `@thermal-label/contracts` and transport classes from
  `@<scope>/transport`.

**Pros:** minimal surgery. One package move.
**Cons:** the name `@<scope>/transport` is lying about what it
contains if it still exports printer-shaped types like
`DeviceDescriptor`. Forces a decision on lifting those.

### 5.2 Option B: Split Contracts

Extract the transport-layer types from `@thermal-label/contracts` into
a new `@<scope>/transport-core` (or merge them into
`@<scope>/transport` itself):

```
@<scope>/transport-core    Transport, TransportType, errors, BluetoothConfig?
@<scope>/transport          The six transport classes (depends on -core)
@thermal-label/contracts   Printer-specific types (depends on -core)
@thermal-label/brother-ql  etc. (depend on both)
```

**Pros:** clean separation. Non-printer projects pull only
transport-core + transport.
**Cons:** one more package to maintain. `@thermal-label/contracts`
becomes a shim that re-exports transport-core types plus adds
printer-specific ones.

### 5.3 Option C: Copy-Paste

If the answer is "I have one other project that needs serial + tcp,"
just copy the two files. The `Transport` interface is ~20 lines;
`TcpTransport` and `SerialTransport` don't share state with anything.

**Pros:** zero ongoing coordination cost. No API surface to maintain
across projects.
**Cons:** divergent bug fixes. If you find a backpressure bug in
TcpTransport here, it doesn't propagate.

**Rule of thumb:** option C for 1 other consumer, option A/B for 2+.

## 6. Impact on Current Consumers

The in-tree consumers are the driver packages. Listing by package:

### 6.1 `@thermal-label/labelmanager`, `@thermal-label/labelwriter`, `@thermal-label/brother-ql`

These currently import:
```typescript
import { UsbTransport, TcpTransport, SerialTransport } from '@thermal-label/transport/node';
import { WebUsbTransport, WebSerialTransport, WebBluetoothTransport } from '@thermal-label/transport/web';
import { buildUsbFilters, buildBluetoothRequestOptions, buildSerialRequestOptions, matchDevice, discoverAll } from '@thermal-label/transport';
```

#### Under Option A (rename only):

Pure rename:
```typescript
import { UsbTransport, TcpTransport, SerialTransport } from '@<scope>/transport/node';
// etc.
```

Plus the USB generalization:
```typescript
// Before:
const transport = await UsbTransport.open(0x04f9, 0x209d);

// After — printer class is no longer the default, callers pick:
const transport = await UsbTransport.open(0x04f9, 0x209d, { class: 'printer' });
// or an explicit shape:
const transport = await UsbTransport.open(0x04f9, 0x209d, {
  interfaceNumber: 0,
  detachKernelDriver: 'usblp',
});
```

Drivers get a one-line change per `open()` call. `class: 'printer'` is
the sugar; the full form is escape-hatch. Same for `WebUsbTransport`.

#### Under Option B (split contracts):

Same as A, plus: `@thermal-label/contracts` consumers don't notice
because the printer-specific types are still there. The transport-layer
types (`Transport`, `TransportType`, errors) are re-exported from
contracts for backwards compat, or contracts is bumped with the
expectation that drivers import transport types directly from
`@<scope>/transport-core`.

Migration: either leave a re-export shim in contracts for one minor
version (easy), or bump contracts to a major and have drivers update
imports (cleaner, more work).

#### Under Option C (copy-paste):

Zero impact. Current consumers keep using `@thermal-label/transport` as
the printer-focused package. The generic version exists elsewhere,
maintained separately, possibly diverging over time.

### 6.2 External Consumers

If this package has shipped to npm and someone outside the monorepo is
using it, a rename is a breaking change (the old name is
deprecated-pointing-to-new, new releases go to the new name). Use
`npm deprecate @thermal-label/transport@* "renamed to @<scope>/transport"`
and publish a final version of the old name that re-exports the new.

Downside of re-exporting: old name shows up indefinitely in
dependency trees.

## 7. Cost Estimate

| Task | Effort |
| --- | --- |
| Drop printer language from JSDoc and README | 2 hours |
| Generalize `UsbTransport.open` / `WebUsbTransport.request` parameters | 1 day incl. tests |
| Make `usblp` detach opt-in | 1 hour |
| Refactor `DeviceNotFoundError` to be transport-neutral | 2 hours |
| Rename package + publish redirect | Half a day |
| Option B: extract transport-core package | 1 day incl. workspace wiring + shim |
| Update three driver packages to new imports + `{ class: 'printer' }` | Half a day total |
| New `HidTransport` / `WebHidTransport` | 2-3 days each |
| `UsbtmcTransport` | 2-3 days |
| `WebMidiTransport` + interface design | 3-5 days, depends on whether a new `MessageTransport` interface is introduced |

**Just the rename + USB generalization + driver updates: ~3 days.**
The new transports are independent projects on top.

## 8. Open Questions

1. **Is there a real second consumer?** The cost/benefit tilts heavily
   on this. One consumer = copy-paste. Two = rename. Three+ = split.
2. **Does `MessageTransport` need to exist?** MIDI, CAN bus, WebSocket,
   anything frame-shaped. The current `read(length)` API is stream-
   shaped. Forcing frame protocols into it works (buffer bytes, parse)
   but loses information. A sibling interface might be cleaner. This
   decision affects whether MIDI is in-scope at all.
3. **Does `DeviceDescriptor` belong in a generic package?** Today it's
   printer-leaning by convention (it's populated by printer registries)
   but shape-neutral. Lift or leave.
4. **What scope name?** `@<scope>/transport`, `@transport-core/core`,
   `@peripheral/transport`, something else. Not worth bike-shedding in
   advance of the decision to do this at all.

## 9. Recommendation (Non-Binding)

If this stays a one-project codebase: **don't do it.** Copy `tcp.ts` +
`serial.ts` into the other project when you need them. A 20-line
interface and two self-contained files aren't worth a package split.

If a real second consumer shows up: **Option A (rename) + USB
generalization.** Low risk, ~3 days, preserves the existing driver
packages with a one-line-per-call change. Skip Option B unless a third
consumer materializes.

New transports (HID, MIDI, USBTMC) are orthogonal to this rename —
decide each on its own merits when the need is concrete. Don't
pre-build them.
