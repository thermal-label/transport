# Implementation Decisions

Judgment calls made during implementation that deviate from, or fill gaps
in, `PLAN.md`. Captured per the pre-flight review resolutions.

## D1 — Root `src/index.ts` exports discovery helpers ONLY

**Plan said:** `src/index.ts` "re-exports everything" (§2).
**Chose:** root exports only platform-neutral symbols:
`matchDevice`, `buildUsbFilters`, `buildBluetoothRequestOptions`,
`discoverAll`. Transport classes live strictly behind `./node` and `./web`.

**Why:** re-exporting `UsbTransport`/`TcpTransport` from the root would
pull the `usb` native addon into any browser bundle that imports
`@thermal-label/transport`, defeating the whole subpath-export split.
Contradiction flagged in pre-flight review.

## D2 — `buildBluetoothRequestOptions` uses `filters[].services` + `optionalServices`

**Plan said:** "maps serviceUuid to requiredServices" (§4).
**Chose:**

```ts
{
  filters: config.namePrefix
    ? [{ namePrefix: config.namePrefix, services: [config.serviceUuid] }]
    : [{ services: [config.serviceUuid] }],
  optionalServices: [config.serviceUuid],
}
```

**Why:** there is no `requiredServices` key on `RequestDeviceOptions`.
The standard Web Bluetooth shape is `filters[].services` (or a
`namePrefix`-only filter) plus `optionalServices` so the returned
`BluetoothDevice` is allowed to access the service.

## D3 — No MTU negotiation for Web Bluetooth

**Plan said:** "attempts MTU negotiation via `server.getPrimaryService()` →
`service.getCharacteristic()`" (§3.4).
**Chose:** use `config.mtu ?? 20` as the chunk size. Full stop.

**Why:** Web Bluetooth does not expose ATT MTU. Chrome negotiates it
internally; there is no API to inspect or request a specific value.
The plan's "negotiation" language was inaccurate. Callers that need a
larger MTU set it explicitly in `BluetoothConfig`.

## D4 — TCP connect timeout throws `TransportError`, not `TransportTimeoutError`

**Plan said:** "throws on connection timeout" (§3.2) without naming the
error type.
**Chose:** `TransportError` base class with `transport: 'tcp'`.

**Why:** `@thermal-label/contracts` defines `TransportTimeoutError`
specifically as "a read timed out waiting for bytes". A connect-phase
timeout is a different failure mode. Using the base `TransportError`
keeps the read-timeout semantics of `TransportTimeoutError` intact.

## D5 — `discoverAll` uses `Promise.allSettled`

**Plan said:** "one failing discovery doesn't block others" (§11)
without naming the mechanism.
**Chose:** `Promise.allSettled`, drop rejections silently, concat
fulfilled values.

**Why:** `Promise.all` short-circuits on the first rejection. The plan's
fault-tolerance guarantee requires `allSettled`. Rejections are dropped
rather than surfaced — discovery is best-effort by design, and the
caller can call an individual `PrinterDiscovery.listPrinters()` if they
need the error detail.

## D6 — `rxCharacteristicUuid` fallback: use TX characteristic for notifications

**Plan said:** `rxCharacteristic?: BluetoothRemoteGATTCharacteristic` (§3.4)
without describing the fallback.
**Chose:** when `BluetoothConfig.rxCharacteristicUuid` is omitted, use
the TX characteristic for both write and notifications.

**Why:** contracts explicitly says "Omit if the TX characteristic also
handles notifications". Some BLE printers (Niimbot, certain Phomemo
models) use a single characteristic for both directions.

## D7 — BLE write pacing: `setTimeout(r, 0)` between chunks

**Plan said:** "Small delay between chunks if needed (some BLE printers
need pacing)" (§3.4).
**Chose:** `await new Promise(resolve => setTimeout(resolve, 0))` between
chunks. No arbitrary millisecond delays in the transport layer.

**Why:** yielding to the event loop is enough to let the Web Bluetooth
stack drain its queue. Printer-specific pacing belongs in the driver,
not the transport — the transport has no way to know which printer it's
talking to.

## D8 — Private constructor + static factory

**Plan said:** all transport classes use `private constructor(...)` + a
static factory (`open`, `connect`, `request`, `fromDevice`).
**Retained.** Existing drivers use public constructors; they will adapt
during retrofit.

**Why:** static factories let construction be fully async (open device,
claim interface, find endpoints) without leaving a partially-initialised
object reachable. Existing drivers that do `new UsbTransport(device)`
will need to switch to `UsbTransport.open(vid, pid)` during retrofit.
Retrofits are out of scope for this package per PLAN.md §11.

## D9 — Idempotent `close()`

**Plan said:** `close()` is async and idempotent on every transport.
**Retained.** Existing drivers throw on second close; they will adapt
during retrofit.

**Why:** idempotent close is a sane default for resource cleanup — it
lets callers `close()` in a `finally` without worrying about whether
some other path already closed. Existing drivers that assume single-shot
close will need to adapt during retrofit. Retrofits are out of scope.

## D10 — Coverage thresholds relaxed from 100%

**Plan said:** nothing explicit; contracts uses 100%.
**Chose:** 95% lines/functions/statements, 90% branches.

**Why:** this package has real I/O surfaces — `navigator.bluetooth`,
`navigator.usb`, `net.Socket`, libusb bindings. Some defensive branches
(mid-write disconnect races, platform-specific kernel-driver paths)
are testable but expensive to cover exhaustively without brittle mocks.
95/90 is high enough to catch regressions without forcing gymnastics.
Contracts is pure types + error constructors, which is why it hits 100.

## D11 — `@types/web-bluetooth` (not `@types/w3c-web-bluetooth`)

**Plan said:** `@types/w3c-web-bluetooth` in devDependencies (§5).
**Chose:** `@types/web-bluetooth` (`^0.0.21`).

**Why:** the plan's package name does not exist on npm registry
(`ERR_PNPM_FETCH_404`). The DefinitelyTyped package for Web Bluetooth is
`@types/web-bluetooth`. `tsconfig` `types` entry is `"web-bluetooth"`
accordingly.

## D12 — Publish deferred (same pattern as contracts)

**Plan said:** Step 9 "Publish to npm".

**Chose:** build the dist, verify thresholds, commit. Do NOT run
`pnpm publish`.

**Why:** publishing is an external, hard-to-reverse action affecting the
public npm registry. See `BLOCKERS.md` for the hand-off.
