# Blockers

Items that could not be completed autonomously and need operator action.

## B1 — npm publish (Step 9)

**Status:** deferred.

The final step of PLAN.md §10 is "Publish to npm". Publishing is:

1. External — affects the public npm registry.
2. Hard to reverse — `npm unpublish` has tight time windows and breaks
   any consumer that already installed.
3. Requires npm credentials / trusted-publisher configuration on the
   `thermal-label` npm org.

Everything up to publishing is done locally:

- Code is written, lints cleanly, typechecks, tests pass above thresholds.
- `pnpm build` emits a clean `dist/`.
- `release.yml` is configured for trusted publishing on `v*` tags.

**To unblock:**

- Option A (recommended): push a `v0.1.0` git tag once you're happy
  with the code. The `release.yml` workflow will publish via OIDC
  trusted publishing — no credentials needed locally.
- Option B: `pnpm publish --access public` from the repo root after
  `pnpm build`. Requires `npm login` with publish rights on the
  `@thermal-label` scope.

No other blockers — the package is publish-ready.
