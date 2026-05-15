---
name: webusb-read-packet-alignment
description: Round WebUsbTransport.read() transfers up to the IN endpoint's wMaxPacketSize so Chromium's transferIn cannot stall on a sub-packet read; then delete the labelwriter STATUS_READ_MIN_LENGTH band-aid.
type: project
---

# @thermal-label/transport — WebUSB read packet alignment

> **Why this plan exists.** A tester ran `@thermal-label/labelwriter`
> (v0.5.0) against a real LabelWriter 550. The device was detected, but
> hitting "print" did nothing — no error, no motion. Audit of the LW5
> (`lw5-raster`) path found the prime suspect is **not** the protocol
> encoder (which is byte-faithful to the spec) but a transport-layer
> read that can hang *before any print bytes are written*.
>
> `WebLabelWriterPrinter.acquire550Lock()` writes `ESC A 1` then does
> `transport.read(32)` to get the 32-byte status reply. On Chromium,
> `USBDevice.transferIn(ep, n)` can stall when `n` is smaller than the
> endpoint's `wMaxPacketSize`: the host controller waits for a
> packet-aligned buffer to fill, the device sent a short packet, and
> the transfer never settles. A hung read inside `print()` means the
> `print()` promise never resolves — exactly the "nothing happened"
> symptom, with no thrown error to surface in the UI.
>
> The labelwriter web driver already half-knows this: `getStatus()`
> reads `Math.max(count, STATUS_READ_MIN_LENGTH)` with a 14-line
> comment describing the Chromium stall. That band-aid (a) only covers
> `getStatus()`, missing `acquire550Lock()`, `getMedia()` and
> `recover()`, and (b) hard-codes `16`, which is a guess — wrong for
> any endpoint with a larger packet size.
>
> **The fix belongs in the transport.** The stall is a property of
> Chromium's WebUSB, so the workaround should live in the one layer
> that has the quirk — and that layer is the only one that can read
> the *real* `wMaxPacketSize` from the endpoint descriptor instead of
> guessing. `WebUsbTransport.read()` will round the `transferIn`
> request up to a whole number of packets, then slice the result back
> down to the caller's requested length so the `read(X)` contract is
> unchanged. The driver-side `STATUS_READ_MIN_LENGTH` magic number is
> then deleted.

The agent runs the **Implementation** sections autonomously, then
switches to interactive mode for **Verification** — the maintainer has
an LW Duo and an LW 400 on the bench and will drive the hardware
steps with the agent.

---

## Background the agent needs

USB bulk IN semantics: a `transferIn(ep, R)` transfer terminates when
either `R` bytes have arrived **or** the device sends a *short packet*
(a packet smaller than `wMaxPacketSize`, including a zero-length
packet). For a request/response device — every DYMO LabelWriter — each
response ends with a short packet, so one `transferIn` == one message.
Rounding `R` up to a multiple of the packet size only adds headroom;
it never merges two messages, because the short packet still
terminates the transfer at the true message boundary. This is why the
fix is safe. (See `libusb`'s "Packets and overflows" doc and USB 2.0
§5.8.3 for the general rule that bulk IN buffers should be a multiple
of `wMaxPacketSize`.)

`USBEndpoint` exposes `.packetSize`, which **is** the endpoint's
`wMaxPacketSize`. `WebUsbTransport.fromDevice()` already resolves the
IN endpoint object, so the value is in hand at construction — no extra
USB calls needed.

LabelWriter status-reply sizes, for reference: `lw5-raster` (550
family) status is **32 bytes**; `lw-raster` (classic 3xx/4xx/Duo label
side) and `d1-tape` (Duo tape side) status are **1 byte**. The SKU
dump (`ESC U`) is 63 bytes, the engine-version block (`ESC V`) 34.

---

## Current state (verified)

`transport/src/web/webusb.ts`
- `private constructor(device, interfaceNumber, endpointOut, endpointIn)`
  — line 34. No packet-size field.
- `fromDevice()` — line 74. Claims the interface, resolves `outEp` /
  `inEp` from the interface descriptor (lines 87-90), constructs the
  transport at line 98. `inEp` is a `USBEndpoint`; `inEp.packetSize`
  is available here and is currently unused.
- `read(length, timeout?)` — line 106. Calls
  `this.device.transferIn(this.endpointIn, length)` directly with the
  caller's `length`, optional timeout race, returns the result bytes
  verbatim.

`labelwriter/packages/web/src/printer.ts`
- `STATUS_READ_MIN_LENGTH = 16` — line 64, with the explanatory
  comment at lines 50-64.
- `STATUS_READ_TIMEOUT_MS = 2000` — line 84. **Keep this** — the
  timeout is orthogonal to packet alignment and still wanted.
- `getStatus()` D1 path — `read(Math.max(D1_STATUS_BYTE_COUNT,
  STATUS_READ_MIN_LENGTH), STATUS_READ_TIMEOUT_MS)`, ~line 302.
- `getStatus()` raster path — `read(Math.max(statusByteCount(...),
  STATUS_READ_MIN_LENGTH), STATUS_READ_TIMEOUT_MS)`, ~line 316.
- `acquire550Lock()` — `read(STATUS_BYTE_COUNT_550)`, line 215, **no
  timeout**.
- `getMedia()` — `read(SKU_INFO_BYTE_COUNT)`, line 249, no timeout.
- `recover()` — `read(statusByteCount(this.device))`, line 373.

`harness/package.json` — `pnpm.overrides` already maps
`@thermal-label/transport` → `link:../transport` and
`@thermal-label/labelwriter-web` → `link:../labelwriter/packages/web`.
So the harness consumes both local checkouts; **no registry publish is
needed for verification** — a local build is enough.

`transport/src/__tests__/webusb.test.ts` — already mocks a `USBDevice`
with `transferIn: vi.fn(...)` and asserts on its call args. The mock
endpoint shape (`InterfaceShape.endpoints`, line 16-19;
`makeConfiguration`, line 21) is `{ endpointNumber, direction }` — it
has **no `packetSize`** and must be extended.

---

## Implementation — Step 1: transport fix (`transport/` repo)

### 1a. Thread the IN endpoint packet size through

In `webusb.ts`:

- Add a private field `private readonly packetSizeIn: number;`.
- Add a `packetSizeIn` parameter to the `private constructor` and
  assign it.
- In `fromDevice()`, pass `inEp.packetSize || 64` as the new argument
  at the construction call site. The `|| 64` is a defensive fallback:
  `packetSize` should always be populated from the descriptor, but a
  `0`/`undefined` would make the round-up math produce `NaN`. 64 is a
  safe floor (rounding a small read up to 64 is harmless on any
  larger-packet endpoint, since the device's short packet still
  terminates the transfer).

### 1b. Round up in `read()`, slice back down

Replace the body of `read()` so it:

1. Computes `aligned = Math.ceil(length / this.packetSizeIn) * this.packetSizeIn`.
2. Calls `transferIn(this.endpointIn, aligned)` (keep the existing
   `timeout` race exactly as-is).
3. Returns `full.subarray(0, Math.min(length, full.byteLength))` —
   **`Math.min`, not a bare `subarray(0, length)`**: if the device
   sent fewer bytes than `length`, callers must see the real count so
   their `bytes.length < EXPECTED` guards still fire.

Reference shape (adapt to the existing timeout block):

```ts
async read(length: number, timeout?: number): Promise<Uint8Array> {
  if (!this._connected) throw new TransportClosedError('usb');
  // Chromium WebUSB: transferIn must request a whole number of
  // wMaxPacketSize-sized packets, else the transfer can stall waiting
  // for a packet-aligned buffer the device never sends. Round the
  // request up to a packet multiple; the device's short packet still
  // terminates the transfer at the true message boundary. Slice the
  // result back to the caller's requested length.
  const aligned = Math.ceil(length / this.packetSizeIn) * this.packetSizeIn;
  const transferPromise = this.device.transferIn(this.endpointIn, aligned);
  const result =
    timeout === undefined
      ? await transferPromise
      : await Promise.race([
          transferPromise,
          new Promise<never>((_, reject) => {
            setTimeout(() => {
              reject(new TransportTimeoutError('usb', timeout));
            }, timeout);
          }),
        ]);
  if (!result.data) return new Uint8Array(0);
  const full = new Uint8Array(
    result.data.buffer,
    result.data.byteOffset,
    result.data.byteLength,
  );
  return full.subarray(0, Math.min(length, full.byteLength));
}
```

Optional defensive warning (include it — it is cheap and a fired
warning means a surprised assumption): if
`result.data.byteLength === aligned`, the transfer filled exactly with
no short packet seen — there may be more data queued for the next
read. `console.warn` in that case. For LabelWriter responses
(32/63/34/1 bytes against 16- or 64-byte endpoints) it should never
fire; if it does during verification, stop and investigate.

### 1c. Diagnostic log in `fromDevice()`

After the endpoints are resolved, add a one-line `console.debug` that
prints the claimed interface number and the resolved IN-endpoint
`packetSize`. This is deliberately kept so the eventual LW 550 harness
retest log will *state* the 550's real packet size instead of anyone
guessing. Add the `// eslint-disable-next-line no-console` comment if
lint requires it (the labelwriter driver uses the same pattern).

### 1d. Tests + checks

Extend `transport/src/__tests__/webusb.test.ts`:

- Add a `packetSize` field to the mock endpoint shape
  (`InterfaceShape.endpoints` and the `makeConfiguration` array
  branch). Give the default `makeDevice()` IN endpoint a realistic
  `packetSize: 64`.
- New `read()` cases:
  - `packetSize: 64`, `read(32)` → asserts `transferIn` was called
    with `(inEp, 64)`.
  - `packetSize: 16`, `read(1)` → asserts `transferIn` called with
    `(inEp, 16)` (the LW Duo / sub-packet case).
  - device `transferIn` resolves 64 bytes, `read(32)` → returned
    `Uint8Array` length is exactly 32.
  - device `transferIn` resolves 3 bytes, `read(32)` → returned length
    is 3 (short response, not padded).
  - endpoint with `packetSize` absent/0 → falls back to 64; `read(1)`
    → `transferIn` called with `(inEp, 64)`.
- Confirm the existing `fromDevice()` / `read()` tests still pass
  (some may need `packetSize` added to their fixtures).

Run in `transport/`: `pnpm test`, `pnpm lint`, `pnpm build`. All must
pass. `pnpm build` is required — the harness consumes transport's
`dist/`, so verification needs a fresh build.

### 1e. Commit (transport repo)

Commit `transport/` on its own: the `webusb.ts` change, the test
changes. Suggested message focus: the *why* (Chromium sub-packet
stall), not just the *what*. Add a Changesets entry describing the fix
as a patch — **do not run `changeset publish` or otherwise publish to
the registry**; the version bump + publish is a follow-up (see below).

---

## Implementation — Step 2: driver cleanup (`labelwriter/` repo)

With the transport handling alignment, the driver band-aid is dead
weight. In `labelwriter/packages/web/src/printer.ts`:

- Delete the `STATUS_READ_MIN_LENGTH` constant and its comment block
  (lines ~50-64).
- `getStatus()` D1 path → `read(D1_STATUS_BYTE_COUNT, STATUS_READ_TIMEOUT_MS)`.
- `getStatus()` raster path → `read(statusByteCount(this.device), STATUS_READ_TIMEOUT_MS)`.
- **Keep `STATUS_READ_TIMEOUT_MS`** and keep passing it — the timeout
  is still wanted; it just no longer needs a companion min-length.
- Recommended (small, do it): pass `STATUS_READ_TIMEOUT_MS` to the
  `acquire550Lock()` `read()` and the `getMedia()` `read()` too. The
  transport fix removes the *stall*, but a defensive deadline on a
  pre-print read is cheap insurance — a non-responsive device becomes
  a thrown timeout the UI can show, not a silent hang.
- If any comment still attributes the WebUSB stall handling to the
  driver, update it to point at `WebUsbTransport.read()`.

Run in `labelwriter/`: `pnpm test`, `pnpm lint`, `pnpm build` (build
`labelwriter-web` so the harness link picks it up). No `package.json`
dependency versions change in this plan, so there is no lockfile to
bump.

Commit `labelwriter/` on its own, separately from the transport
commit.

---

## Out of scope — do NOT do these

- **Do not touch the node transport** (`transport/src/node/usb.ts`).
  libusb does not have the Chromium sub-packet stall; the node
  `read()` handles sub-packet requests fine. Leave it alone.
- **Do not publish** `@thermal-label/transport` (or labelwriter) to
  the registry. The harness consumes both via local `link:`
  overrides — a local build is all verification needs.
- **Do not change the `lw5-raster` protocol encoder**
  (`protocol-550.ts`). The audit found the encoder byte-faithful to
  the spec. Separate, lower-priority 550 protocol-logic questions were
  noted (lock-state handling for status byte `4` vs `0..3`; `ESC T`
  emitted after `ESC C` rather than before) — these are **not** in
  scope here and should not be bundled in.
- **Do not attempt to verify the 550 itself** — there is no 550 on the
  bench (see Verification). The original incident's 550-specific
  retest is an external follow-up.

---

## Verification — interactive, with the maintainer

Switch to interactive mode here. The maintainer has an **LW Duo** and
an **LW 400** on the bench; there is **no LW 550**. That is fine: this
plan fixes the *transport*, which is protocol-agnostic. The two
available devices fully exercise the fix; the 550's protocol behaviour
is a separate retest.

### Tier 1 — unit (no hardware)

Run `pnpm test` in `transport/`. The new `read()` cases are the
authoritative regression net. Confirm green before touching hardware.

### Tier 2 — hardware regression

The LW Duo's label interface (IF 0, `lw-raster`, observed 16-byte bulk
packets) is the device that originally surfaced the stall, so it is
the **sensitive probe**: if the round-up is wrong, `getStatus()` on
the Duo's 16-byte endpoint hangs again. The LW 400 (`lw-raster`,
expected 64-byte endpoint) exercises a different packet size.

Build, then run the labelwriter harness:
1. `pnpm build` in `transport/`, then in `labelwriter/`.
2. From `harness/`, `pnpm install` (refresh the links) and start
   `harness-labelwriter` (`pnpm --filter @thermal-label/harness-labelwriter dev`).
3. Open the harness in Chrome.

Guide the maintainer through, one device at a time. For **each** of
the LW Duo and the LW 400:
- Connect the device through the harness USB picker.
- Read the browser console for the `fromDevice` debug line — record
  the resolved IN-endpoint `packetSize` for each interface. Expect
  ~16 on the Duo IF 0 / IF 1, ~64 on the LW 400. Note the actual
  numbers in the report.
- Call `getStatus()` — for the Duo do it on **both** engine tabs
  (label + tape). It must **return** (not hang) and report a sane
  status. A hang here means the transport round-up is wrong — stop
  and debug.
- Print a test label. The LW Duo print exercises the `lw-raster`
  label engine end-to-end; the LW 400 print is the plain classic
  path. Both should print correctly.
- Confirm the optional desync `console.warn` from step 1b never
  fires.

Ask the maintainer to confirm pass/fail per device and per check. If
anything stalls or misprints, capture the console log and the
`packetSize` values before changing anything.

### Coverage note to give the maintainer

Tier 1 + Tier 2 verify the transport fix across a 16-byte and a
64-byte endpoint — the identical code path then handles the 550's
endpoint. What is **not** covered here: the `lw5-raster` 32-byte
status, `acquire550Lock`, and the 63-byte `getMedia` read, plus
whether the 550 *protocol* job stream actually prints. Those need the
original tester's LW 550, retested through the harness (so the
`packetSize` debug line and status bytes are captured). Flag this
explicitly as the remaining open item.

---

## Follow-ups (not for this agent)

- Publish `@thermal-label/transport` with the patch bump, then bump
  the consuming `@thermal-label/transport` dependency ranges in the
  labelwriter packages and refresh their lockfiles — the standard
  pre-deploy publish step. Tracked separately from this fix.
- LW 550 harness retest by the external tester, with console capture,
  to close the original incident and confirm the `lw5-raster` print
  path end-to-end.
- Revisit the noted 550 protocol-logic questions (status byte `4`
  lock-state handling; `ESC T` ordering) if the 550 retest still
  misbehaves after the transport fix.
