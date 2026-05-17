# webusb-read-packet-alignment — implementation log

Status: **Complete.** Transport fix + labelwriter cleanup shipped per plan;
labelmanager-web given the same cleanup as a hot-context follow-up. Tier-1
green; Tier-2 hardware verification passed. Only the LW 550 path is
unverified (no 550 on the bench — external follow-up).

## Commits

- `transport` — `b479103` fix(web): round WebUSB reads up to the IN endpoint packet size
- `labelwriter` — `b12832a` refactor(web): drop STATUS_READ_MIN_LENGTH, lean on transport packet alignment
- `labelmanager` — `6fc17c8` refactor(web): drop STATUS_READ_LENGTH, lean on transport packet alignment

## Tier-1 results

- `transport`: test 129/129 pass, lint clean, build clean.
- `labelwriter`: test — web 32/32, core 209, node 62 (+2 skipped) pass; build clean (core/node/web).

## Decisions / deviations from the plan

1. **No changeset in `transport`.** The plan said add one; `transport/` has
   no `.changeset/` dir and does not use Changesets. Skipped rather than
   scaffold that infrastructure. The version bump remains a follow-up.
2. **Changeset added in `labelwriter`** (`.changeset/drop-status-read-min-length.md`,
   `@thermal-label/labelwriter-web` patch). The plan's Step 2 didn't mention
   one, but the repo has 7 pending changesets — adding one matches convention
   and stands in for the transport changeset that couldn't be created.
3. **WebUSB test mock rewrite (not anticipated by the plan).** The transport
   packet round-up exposed a fidelity bug in `labelwriter/.../webusb-mock.ts`:
   it streamed `__statusBytes` with a flat cursor, so an over-aligned read
   leaked the *next* reply's bytes into the current one (the 550 SKU
   auto-fetch test failed). Real bulk-IN request/response devices terminate
   each transfer with a short packet at the message boundary. The mock now
   models one-transfer-per-message; multi-reply tests script a `[reply, ...]`
   array. This is a correctness fix — the old mock could not validate the
   new transport behaviour.
4. **`labelwriter` `pnpm lint` is already red on `main`** — 9 pre-existing
   errors (4 in `printer.ts` deprecated functions, 5 in unrelated files),
   confirmed by stashing this change and re-running. This change adds **zero**
   new violations (my rewritten test files lint clean). The pre-existing
   errors were left untouched — out of scope.
5. **`transport` `src/web/web-bluetooth.ts`** has pre-existing uncommitted
   WIP (unrelated to this fix) that fails one web-bluetooth test. Left
   untouched and unstaged; with it stashed, transport is 129/129 green.
6. Optional desync `console.warn` in `read()` included per the plan.

## labelmanager-web — follow-up cleanup (commit `6fc17c8`)

A quick-look review found `labelmanager/packages/web/src/printer.ts`
carried the same class of band-aid: `STATUS_READ_LENGTH = 64`, a
hard-coded packet-aligned read length (no comment, no timeout). Given
the transport fix, applied the same Step-2 cleanup:
`read(STATUS_READ_LENGTH)` → `read(D1_STATUS_BYTE_COUNT, STATUS_READ_TIMEOUT_MS)`.
Its WebUSB mock returns a fixed 1-byte reply regardless of requested
length, so — unlike the labelwriter mock — it needed no change.
Changeset added (`@thermal-label/labelmanager-web` patch). Tests: core
8, node 16 (+1 skip), web 18 pass.

## Tier-2 hardware verification — PASSED

Resolved IN-endpoint packet sizes (recorded from the `fromDevice` debug
line) and results:

- **LW Duo** — IF 0 (label, `lw-raster`) packetSize **16**; IF 1 (tape,
  `d1-tape`) packetSize **64**. `getStatus()` returned on both engines
  (`[lw-web] getStatus read role=label len=1` — the sub-packet read on
  the 16-byte endpoint that originally stalled); print OK.
- **LW 330 Turbo** — tested, functional.
- **LW 400** — tested, functional.
- **LabelManager PnP** — IF 0 (EP 5) packetSize **64**. `getStatus()` /
  `onStatus` polling tracks live tape unload/load correctly. (LM
  `print()` does no `read()`, so `getStatus()` is the full read-path
  surface for the labelmanager change.)

Desync `console.warn` never fired on any device.

## Open follow-ups

- Publish `@thermal-label/transport` patch (no `.changeset/` infra —
  manual bump), then bump the `@thermal-label/transport` dep range +
  lockfiles in the labelwriter and labelmanager packages.
- LW 550 retest by the external tester: the `lw5-raster` 32-byte status,
  `acquire550Lock`, and 63-byte `getMedia` reads remain unverified — no
  550 on the bench.
