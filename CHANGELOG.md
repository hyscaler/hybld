# Changelog

All notable changes to the hybld packages are documented here. All packages version together (linked via Changesets); per-package changelogs are generated from 1.0.0 onward.

## 1.1.0 (2026-11-12)

Includes the 1.0.1 pacing fix below, which was never published on its own.

- Batched framework builds for Next.js and Astro: `render.batchSize` (or
  `--batch-size <n>`) splits a large scope into several framework builds
  in one command. Every batch carries all page types, assets merge after
  each batch, and the manifest is checkpointed between batches, so a
  crash late in a long first build resumes instead of starting over.
- Image optimization: `images.optimize` caps the width of downloaded
  raster images and re-encodes them (WebP by default) through the
  optional `sharp` package.
- The CLI no longer prints Node's SQLite ExperimentalWarning on every run.
- The changed-files report lists each file once when it was written by
  more than one batch.

## 1.0.1 (2026-09-16)

- http: the requestsPerSecond throttle now paces concurrent requests
  correctly. In-flight requests used to sleep against the same stale
  timestamp and fire together, bursts of up to `concurrency` requests
  per gap (effective rate = concurrency x requestsPerSecond). Start
  slots are now reserved atomically, so the configured rate holds under
  any concurrency. The reactive 429/Retry-After backoff was never
  affected.

## 1.0.0 (2026-08-19)

First stable release. Validated end to end against two live production
APIs (a public WordPress REST site and a custom GraphQL news API)
through the published packages, across all three frameworks.

- serve: percent-encoded request paths are now decoded before file
  resolution, so Next App Router per-route chunks (emitted under literal
  [slug] directories and requested URL-encoded by browsers) load
  correctly under `hybld serve`; encoded traversal attempts remain
  blocked by the same guard, and malformed encodings 404 cleanly.
- starter-next: real UI with client-side interactivity (reading-progress
  bar, relative timestamps, localStorage clap button, client-side list
  filter) that doubles as visible hydration proof on incrementally
  built pages.

## 1.0.0-beta.3 (2026-08-19)

- Refuse `--clean` combined with a narrow build scope: a clean followed by a
  targeted build would have left the deployed site with only the scoped pages.
  `--all --clean` remains the sanctioned full-rebuild path.
- Node preflight in the CLI entry: Node < 22.5 now prints a clear upgrade
  message instead of a cryptic `node:sqlite` module error.
- `hybld --version` / `-v` prints the package version.
- Serve-mode memory bounds: the regen-on-miss negative cache is now
  size-capped (10k entries, stalest-first eviction) so junk-URL floods cannot
  grow a long-lived process, and the per-run CMS response memo is released at
  the end of each build instead of being retained while idle.
- `prepublishOnly` build hooks on every package (a publish can never ship a
  stale dist); CI now tests Node 22 (the engines floor) alongside 24.
- Repo: three clone-and-run starter examples (React + Vite, Next.js, Astro)
  against a live public WordPress API, verified end to end.

## 1.0.0-beta.2 (2026-08-06)

- Rewrote every package README as comprehensive standalone documentation
  (setup, full wiring for both Next routers and Astro, helper API references,
  renderer option tables, recipes, production runbooks, troubleshooting,
  migration guides; adapter options and capability matrices).
- No code changes relative to beta.1.

## 1.0.0-beta.1 (2026-08-06)

First public release, under the `beta` dist-tag.

- Incremental static site generation for CMS-backed sites: SQLite manifest, content hashing, dependent-page regeneration, deletion and slug-move handling.
- Build scopes: `--all`, `--limit`, `--chunk i/n`, `--chunk-size`, `--routes/--slugs/--ids`, `--since last-build`, `--stale`.
- Render backends: owned React + Vite renderer (worker pool, build reuse, Vite plugin mode, draft previews) and delegated Next.js (App and Pages Router) and Astro backends via `@hybld/next` and `@hybld/astro`.
- CMS adapters: WordPress, Strapi, Contentful, Sanity presets plus generic REST and GraphQL helpers, all on a shared rate-limited HTTP layer.
- Operations: `hybld serve` (webhooks, static hosting, ISR-style regeneration on miss), `hybld sync` deploy diffs, sharded sitemap, RSS feed, redirects map, asset garbage collection, manifest push/pull.
