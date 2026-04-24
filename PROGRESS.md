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

- [ ] README per PLAN.md §7
- [ ] Commit + push

## Step 9 — Final

- [ ] `pnpm test:coverage` — thresholds green
- [ ] All PROGRESS.md checkboxes ticked
- [ ] Publish to npm (operator — see BLOCKERS.md)
- [ ] Commit + push
