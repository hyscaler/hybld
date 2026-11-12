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
- `packages/next`, `packages/astro`, `packages/sveltekit`, `packages/nuxt`: delegated framework backends
- `packages/adapter-*`: CMS presets
- `examples/`: three starters on the published packages against a live public API, and six internal demos on workspace code against the mock CMS (`cd examples/demo-site && node mock-cms/server.mjs`, port 4399); see `examples/README.md`
- `docs/`: documentation site (Astro Starlight; `cd docs && npm install && npm run build`)

## Making changes

1. Branch from `development`.
2. Make the change with tests (`packages/*/test`). Build before testing: tests import from `dist`.
3. Add a changeset describing the change: `pnpm changeset` (pick the affected packages and semver bump).
4. Open a pull request against `development`.

## Releasing (maintainers)

All nine packages version together. The flow used for every release so far:

1. Set the same new version in every `packages/*/package.json`.
2. Add a dated section to `CHANGELOG.md` describing the release.
3. `pnpm install` (refresh lockfile), then `pnpm run build && pnpm test`.
4. If pnpm's release-age policy complains after publish, add the fresh
   `<pkg>@<version>` entries to `minimumReleaseAgeExclude` in
   `pnpm-workspace.yaml` so the repo can install its own new release.
5. Publish (needs npm 2FA; a `404` on the publish PUT means the npm
   token expired, run `npm login` first):

```bash
pnpm -r publish --access public --publish-branch development
```

`latest` moves automatically on a stable publish; prereleases add
`--tag beta`. Tag the release (`git tag vX.Y.Z && git push origin vX.Y.Z`).
Changesets is configured (`pnpm changeset`) as an optional alternative
for accumulating change notes between releases.
