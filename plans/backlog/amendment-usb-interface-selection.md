---
name: amendment-usb-interface-selection
description: Let UsbTransport / WebUsbTransport claim a non-default interface so composite USB devices (LabelWriter 450 Duo) can route per-engine traffic.
type: project
---

# @thermal-label/transport — Amendment: USB Interface Selection

> Today both `UsbTransport` (node) and `WebUsbTransport` (web)
> hard-claim **interface 0** of the chosen USB device. That covers
> every printer family currently shipped — they're all single-interface
> printer-class devices.
>
> The LabelWriter 450 Duo breaks that assumption. It's a **composite
> USB device** (one `vid/pid`, two printer-class interfaces): label
> side on `bInterfaceNumber: 0`, tape side on `bInterfaceNumber: 1`.
> Driving the tape side requires opening the same device a second
> time and claiming a different interface.
>
> The labelwriter contracts shape already declares this — each Duo
> entry's `engines[]` carries `bind.usb.bInterfaceNumber`. What's
> missing is the runtime piece. This amendment adds a per-engine
> interface-binding hint to the transport open path. See
> `../labelwriter/plans/backlog/duo-tape-support.md` §5.5 for the
> caller-side context.

---

## 1. Current state (verified)

`src/node/usb.ts:10` — `const INTERFACE_NUMBER = 0;`, used at `:63` to
claim the first interface unconditionally. `device.open()` is called
once per `UsbTransport`, and `close()` calls `device.close()` — so two
`open(vid, pid)` calls against the same physical device would race
on libusb's per-device handle.

`src/web/webusb.ts:7` — same shape: `const INTERFACE_NUMBER = 0;`
hard-coded, claimed at `:66`. WebUSB is more forgiving (multiple
`USBDevice` instances can coexist) but the transport still hard-codes
the interface number and the endpoint lookup keys off it.

No `OpenOptions` struct exists in `@thermal-label/contracts` yet — the
`amendment-serial.md` plan referenced one, but the implemented version
just took a `path` arg. So this amendment is the first time we need to
pipe a structured option through.

---

## 2. Goal

A driver — given a resolved engine binding `{ usb: { bInterfaceNumber: 1 } }`
— can call:

```typescript
const transport = await UsbTransport.open(vid, pid, { bInterfaceNumber: 1 });
```

and get back a transport bound to that interface, with its own
endpoints, that can coexist with a sibling `UsbTransport` claiming
`bInterfaceNumber: 0` on the same physical device.

The single-arg form `UsbTransport.open(vid, pid)` continues to work
and continues to claim interface 0. **Additive, no breaking change.**

---

## 3. API surface

### 3.1 Node — `UsbTransport`

```typescript
export interface UsbOpenOptions {
  /** Defaults to 0 for backward compatibility. */
  bInterfaceNumber?: number;
}

class UsbTransport {
  static async open(
    vid: number,
    pid: number,
    options?: UsbOpenOptions,
  ): Promise<UsbTransport>;

  static async openDevice(
    descriptor: DeviceDescriptor,
    options?: UsbOpenOptions,
  ): Promise<UsbTransport>;
}
```

Endpoint lookup moves from "first IN/OUT on interface 0" to "first
IN/OUT on the claimed interface". The error message updates to name
the interface number.

### 3.2 Web — `WebUsbTransport`

```typescript
export interface WebUsbOpenOptions {
  /** Defaults to 0 for backward compatibility. */
  interfaceNumber?: number;
  /** Defaults to 1 (existing behavior). */
  configurationValue?: number;
}

class WebUsbTransport {
  static async request(
    filters: USBDeviceFilter[],
    options?: WebUsbOpenOptions,
  ): Promise<WebUsbTransport>;

  static async fromDevice(
    device: USBDevice,
    options?: WebUsbOpenOptions,
  ): Promise<WebUsbTransport>;
}
```

The `interfaceNumber` field is named to match the WebUSB API
(`device.claimInterface(interfaceNumber)`), not the libusb-flavoured
`bInterfaceNumber` used on the node side. Naming inconsistency is
deliberate — each side mirrors its underlying API.

### 3.3 Contracts (no change required)

The bind hint already lives in the labelwriter device data
(`bind.usb.bInterfaceNumber`). The transport package does not need
to know about that shape — drivers extract the field and pass it
through. So `@thermal-label/contracts` is untouched by this
amendment.

(If a future plan introduces a generic `OpenOptions` discriminated
union in contracts, the USB variant can subsume `UsbOpenOptions`
then.)

---

## 4. The hard problem — concurrent interface claims on Node

WebUSB is fine: each call to `navigator.usb.getDevices()` /
`requestDevice()` returns a `USBDevice` that can be opened
independently, and `claimInterface` is per-interface.

libusb (the `usb` npm package) is **not** fine out of the box. The
current `UsbTransport.open` does:

```typescript
const device = getDeviceList().find(...);  // same Device object across calls
device.open();                              // refcounted; 2nd call: harmless or error?
const iface = device.interface(N);
iface.claim();
```

And `close()` does:

```typescript
await this.iface.releaseAsync();
this.device.close();                        // unrefs; if other transport holds it, kills it
```

If a driver opens both `(vid, pid, {bInterfaceNumber: 0})` and
`(vid, pid, {bInterfaceNumber: 1})` against a real Duo, two
`UsbTransport` instances will share the same underlying `Device`
handle. Closing one would `device.close()` the shared handle and
break the other.

Three options:

### Option A — Per-(vid,pid) device cache + refcount

The module keeps a `Map<vid:pid, { device, refcount }>`. `open()`
either returns a cached entry incrementing refcount, or creates a
new one. `close()` decrements; the last `close()` calls
`device.close()` for real.

- **Pros:** transparent to callers. Two `UsbTransport.open` calls
  against the same composite device just work.
- **Cons:** module-level mutable state. Test-mocking gets fiddler
  (the cache needs a reset hook). Edge case: if two callers open
  with different VID/PID combos that map to the same device (e.g.
  serial-number-disambiguation in the future), cache key gets
  more complex.

### Option B — Two-step open (`Device` then `Interface`)

Expose a separate `UsbDevice` handle that owns `device.open/close`,
and have `UsbTransport` claim an interface against that handle:

```typescript
const dev = await UsbDevice.open(vid, pid);
const label = await UsbTransport.fromDevice(dev, { bInterfaceNumber: 0 });
const tape  = await UsbTransport.fromDevice(dev, { bInterfaceNumber: 1 });
await label.close();   // releases interface 0
await tape.close();    // releases interface 1
await dev.close();     // closes libusb device
```

- **Pros:** explicit ownership, no hidden state. Mirrors WebUSB's
  `fromDevice` shape.
- **Cons:** breaking change for callers who want the
  composite-device case. Single-engine printers don't care, but
  the Duo driver has to learn the two-step dance. Discovery
  helpers also need updating.

### Option C — Punt: document "one transport per device"

Keep the API single-arg-equivalent and document that the second
interface needs a different code path entirely. Effectively
abandons composite-device support in the transport layer.

- **Pros:** zero work in this package.
- **Cons:** pushes the problem to every consumer. Defeats the
  purpose of the abstraction.

**Recommendation: Option A.** It keeps the caller-facing API simple
(driver code reads `engine.bind.usb.bInterfaceNumber` and passes
it to `open`, done), the cache is internal, and the "two
transports, same device" case is rare enough that the refcount
machinery stays small. The `Map` lives at module scope behind a
small `acquireDevice(vid, pid) / releaseDevice(...)` pair; tests
get a `__resetDeviceCacheForTests()` export gated to non-prod.

If Option A's hidden state turns out to bite us in tests or in some
future multi-process scenario, Option B is a clean migration —
`UsbTransport.fromDevice(UsbDevice, options)` can be added
alongside without removing the cache-backed `open(vid, pid, options)`.

---

## 5. Per-transport changes

### 5.1 `src/node/usb.ts`

- Replace the `INTERFACE_NUMBER = 0` constant with a parameter
  threaded through `open` / `openDevice`.
- Introduce a module-private device cache (Option A from §4):
  - `acquireDevice(vid, pid): { device, release }`
  - First call: `getDeviceList().find` + `device.open()`, refcount = 1.
  - Subsequent calls for same `(vid, pid)`: refcount++, return same handle.
  - `release()` decrements; at 0, `device.close()` and remove from map.
- `UsbTransport.close()` calls the per-instance `release` instead
  of `device.close()` directly.
- The Linux `usblp` kernel-driver detach (`src/node/usb.ts:68-70`)
  already runs per-interface and stays correct.
- Endpoint discovery (`:73-78`) keys off the claimed `iface`, not
  a hardcoded interface — change is mechanical.
- Update the JSDoc on `UsbTransport` (currently "Assumes a USB
  Printer Class device on interface 0") to reflect the new
  parameter.

### 5.2 `src/web/webusb.ts`

- Add `WebUsbOpenOptions` plumbing through `request` and
  `fromDevice`.
- Replace `INTERFACE_NUMBER` constant usage with the resolved
  parameter; ditto for `CONFIGURATION_VALUE` (rare but the
  capability is free once we're touching the open path).
- No device-cache concern here — WebUSB allows multiple
  `claimInterface` calls on the same `USBDevice` independently.

### 5.3 `src/discovery.ts`

No required change. The `buildUsbFilters` helper just builds
`{ vendorId, productId }` filters; the interface number is
orthogonal. If we want a convenience helper that resolves
`engine.bind.usb` from a contracts-shape descriptor into our
options object, that's a labelwriter-side ergonomics question,
not a transport-package concern.

---

## 6. Tests

### 6.1 `src/__tests__/usb.test.ts` (extend)

- `UsbTransport.open(vid, pid)` — claims interface 0 (existing).
- `UsbTransport.open(vid, pid, { bInterfaceNumber: 1 })` — claims
  interface 1, picks endpoints from interface 1.
- Two `open` calls with the same `(vid, pid)` and different
  interface numbers — both succeed, share the underlying device.
- Closing one leaves the other operational; `device.close` is
  called only after both transports close (refcount goes to 0).
- Closing the same transport twice is idempotent and does not
  underflow the refcount.
- `bInterfaceNumber` pointing at a non-existent interface raises
  a clear error (not a libusb panic).
- The fake usb mock needs to expose `interface(n)` returning a
  per-`n` object with its own endpoints; existing mock assumes
  one interface.

### 6.2 `src/__tests__/webusb.test.ts` (extend)

- `WebUsbTransport.fromDevice(device, { interfaceNumber: 1 })` —
  claims interface 1, looks up endpoints from interface 1.
- Default behaviour (no options) still claims interface 0 and
  configuration 1.
- Custom `configurationValue` triggers `selectConfiguration`.
- Endpoints found on the *correct* interface — easy to regress if
  the lookup keeps using a stale constant.

### 6.3 Cache-reset hook

Add `__resetDeviceCacheForTests()` (or similar) to keep the node
tests deterministic. Not exported from the package's public types.

---

## 7. Versioning + release

This is **additive and backward-compatible** for every existing
caller (single-arg form unchanged). Bump as a **minor**:
`0.2.x → 0.3.0`.

The labelwriter and labelmanager packages need a `^0.3.0` peer-dep
bump in lockstep, because the `engines[]` shape in labelwriter
contracts depends on the new options being available. Coordinate
the publishes:

1. `@thermal-label/transport@0.3.0` ships first.
2. `@thermal-label/labelwriter-*` consumes it; the `d1-tape`
   protocol module work proceeds (see `duo-tape-support.md` §5.2+).
3. `@thermal-label/labelmanager-*` does **not** need to update
   immediately — it remains on the single-arg form.

---

## 8. Open questions

1. **Device cache key.** `vid:pid` works for one-Duo-attached. If a
   user has two Duos plugged in, the cache key collapses them
   into one entry and both drivers fight over the same device.
   `getDeviceList().find` already only matches the first device,
   so this is a pre-existing limitation, not a new one — but
   worth flagging that multi-device disambiguation
   (serialNumber, busNumber/deviceAddress) is a separate
   follow-up.
2. **`detachKernelDriver` per interface.** On Linux, `usblp`
   auto-claims each printer-class interface independently. The
   detach call is already inside `iface.isKernelDriverActive()`
   so it should DTRT for both interfaces of a Duo, but it's
   worth verifying with `lsusb -v` + `dmesg` on real hardware
   that detaching interface 1 doesn't disturb interface 0's
   already-released kernel binding.
3. **WebUSB `selectConfiguration` race.** The current code only
   calls `selectConfiguration` if the device isn't already on
   config 1. With two `WebUsbTransport.fromDevice` calls
   in flight on the same `USBDevice`, both could observe a
   stale configuration and both call `selectConfiguration`.
   In practice browsers serialise this, but worth a defensive
   check after the first call.
4. **Whether to expose `acquireDevice` publicly.** If a future
   driver wants finer control (e.g. share a device handle across
   transports without going through the open(vid, pid) overload),
   Option B's `UsbDevice` handle is the natural escape hatch.
   Don't ship it speculatively — wait for a second caller.

---

## 9. Implementation checklist

```
□ src/node/usb.ts — add UsbOpenOptions, thread bInterfaceNumber through
□ src/node/usb.ts — module-scope device cache (acquire/release/refcount)
□ src/node/usb.ts — endpoint lookup keyed off resolved interface
□ src/node/usb.ts — update JSDoc to drop "interface 0" assumption
□ src/web/webusb.ts — add WebUsbOpenOptions, thread interfaceNumber through
□ src/web/webusb.ts — endpoint lookup keyed off resolved interface
□ src/__tests__/usb.test.ts — extend mocks, add multi-interface cases
□ src/__tests__/webusb.test.ts — interface-selection cases
□ Add __resetDeviceCacheForTests() (test-only export)
□ Update README — document UsbOpenOptions + composite-device caveat
□ Gate: typecheck + lint + test + build
□ Bump version to 0.3.0, publish
□ Coordinate labelwriter-core + labelwriter-node peer-dep bump
```
