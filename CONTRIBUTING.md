# Contributing to hybld

## Setup

Requires Node >= 22.5 and pnpm.

```bash
pnpm install
pnpm run build     # builds all packages (tests import from dist)
pnpm test          # builds, then runs all test suites
```

## Repository layout

- `packages/hybld`: core engine (manifest, scopes, dependents, renderer, serve, CLI)
- `packages/next`, `packages/astro`: delegated framework backends
- `packages/adapter-*`: CMS presets
- `examples/`: four demo apps, e2e-verified against the mock CMS (`cd examples/demo-site && node mock-cms/server.mjs`, port 4399)
- `docs/`: documentation site (Astro Starlight; `cd docs && npm install && npm run build`)

## Making changes

1. Branch from `development`.
2. Make the change with tests (`packages/*/test`). Build before testing: tests import from `dist`.
3. Add a changeset describing the change: `pnpm changeset` (pick the affected packages and semver bump).
4. Open a pull request against `development`.

## Releasing (maintainers)

```bash
pnpm changeset version   # applies pending changesets, bumps versions, writes changelogs
pnpm install             # refresh lockfile
pnpm run build && pnpm test
pnpm -r publish --access public
```
