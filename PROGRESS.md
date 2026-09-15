# Implementation Progress

Tracks completion of the steps in `PLAN.md` §10.

## Step 1 — Scaffold

- [x] LICENSE (MIT, Mannes Brak)
- [x] .github/FUNDING.yml
- [x] package.json
- [x] tsconfig.json (wide, noEmit)
- [x] tsconfig.build.json (narrow, emits to dist)
- [x] eslint.config.js
- [x] vitest.config.ts
- [x] .github/workflows/ci.yml
- [x] .github/workflows/release.yml
- [x] .gitignore
- [x] PROGRESS.md / DECISIONS.md / BLOCKERS.md
- [x] `pnpm install` completes cleanly
- [x] Commit + push

## Step 2 — UsbTransport

- [x] `src/node/usb.ts`
- [x] `src/__tests__/usb.test.ts`
- [x] Gate: typecheck + lint + test + build
- [x] Commit + push

## Step 3 — TcpTransport

- [x] `src/node/tcp.ts`
- [x] `src/node/index.ts`
- [x] `src/__tests__/tcp.test.ts`
- [x] Gate: typecheck + lint + test + build
- [x] Commit + push

## Step 4 — WebUsbTransport

- [x] `src/web/webusb.ts`
- [x] `src/__tests__/webusb.test.ts`
- [x] Gate: typecheck + lint + test + build
- [x] Commit + push

## Step 5 — WebBluetoothTransport

- [x] `src/web/web-bluetooth.ts`
- [x] `src/web/index.ts`
- [x] `src/__tests__/web-bluetooth.test.ts`
- [x] Gate: typecheck + lint + test + build
- [x] Commit + push

## Step 6 — Discovery helpers

- [x] `src/discovery.ts`
- [x] `src/__tests__/discovery.test.ts`
- [x] Gate: typecheck + lint + test + build
- [x] Commit + push

## Step 7 — Root index

- [x] `src/index.ts` — discovery helpers ONLY (no transport classes)
- [x] Verify all three subpath exports emit correctly
- [x] Gate: typecheck + lint + test + build
- [x] Commit + push

## Step 8 — README

- [x] README per PLAN.md §7
- [x] Commit + push

## Step 9 — Final

- [x] `pnpm test:coverage` — thresholds green (100 / 93.78 / 100 / 100)
- [x] All PROGRESS.md checkboxes ticked
- [ ] Publish to npm (operator — see BLOCKERS.md)
- [x] Commit + push

## 0.6.1 — enumeration behind transport (plan 15 + plan 17 step 2)

- [x] `enumerateUsbDevices` (DECISIONS D13)
- [x] `snmpGet` / `snmpBroadcast` / `PRINTER_MIB` (`src/node/snmp.ts`)
- [x] `matchModelName` (isomorphic, needs contracts ≥ 0.6.2 `modelNames`)
- [x] `enumerateNetworkDevices` / `identifyNetworkDevice` (DECISIONS D14)
- [x] Tests: BER round-trips, local `dgram` agent stub, mocked broadcast, mocked discovery
- [x] Docs: `docs/index.md`, README, typedoc
- [ ] Pin `@thermal-label/contracts` to `^0.6.2` + lockfile once it is on npm
- [ ] Publish (after the PR merges)
