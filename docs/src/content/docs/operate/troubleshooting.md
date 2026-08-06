---
title: "Troubleshooting"
description: "Error messages and their fixes, behavior questions, and environment notes."
sidebar:
  order: 3
---
## Errors and what they mean

**`hybld config not found in ...`**
No `hybld.config.{ts,mts,js,mjs}` in the working directory. Run from the project root or pass `--config`.

**`index.html is missing the <!--app-html--> placeholder required by hybld.`**
React + Vite backend: both `<!--app-head-->` and `<!--app-html-->` must exist in your template. See the [React + Vite guide](/frameworks/react-vite/).

**`Another hybld build is running (lock: ...)`**
A second build tried to start. Use `--wait` to queue behind it. Stale locks from crashed processes clear themselves (PID + heartbeat detection).

**`--since last-build requires a previous build`**
The manifest has no build record yet; run any scope once first.

**`No collection adapter implements listModifiedSince(); --since is unavailable.`**
Your adapter (or custom API) cannot filter by modification date. Use targeted builds driven by webhooks, or full/chunked builds.

**`Adapter "..." does not implement listTerms(); cannot enumerate taxonomy ...`**
An aggregate's `enumerate` calls `cms.listTerms` but the adapter lacks taxonomy support. Implement `listTerms` or enumerate from your own endpoint.

**`hybld outDir must differ from the <framework> build dir`**
Delegated backends stage the framework's output and merge it into hybld's cumulative outDir; they cannot be the same directory. Set `outDir: "site"`.

**`Page "..." is missing "generateStaticParams()" so it cannot be used with "output: export"` (Next)**
Every dynamic route in a hybld-driven Next app must call `hybldParams` in `generateStaticParams`. hybld keeps at least one page per dynamic route type in every batch (padding, plus promoting a fresh page back in when a targeted run would otherwise skip a whole type), so if this still appears, the page genuinely lacks the `hybldParams` call.

**`render of <route> timed out after <n>ms`** (react-vite)
A render function did not resolve within `render.timeout` (default 60s). The page fails (recorded in the summary) instead of stalling the build. Usually a render awaiting something that never settles (an un-timed-out fetch, an infinite Suspense loop). Raise `render.timeout` for legitimately slow renders.

**`all render workers exited; SSR bundle may be failing at load time`** (react-vite)
Every worker crashed at module load, typically because the SSR entry touches a browser-only global (`window`, `document`) at import time. Guard such access behind a runtime check. A single worker crashing mid-render is retried automatically; this error means the bundle itself cannot load.

**`hybld serve: binding to <host> without --secret ...`**
`serve` binds to `127.0.0.1` by default. Binding wider (e.g. `--host 0.0.0.0`) exposes build-triggering POST endpoints, so it requires `--secret`. Set one, keep the default loopback bind, or pass `--insecure` if you accept the risk.

**`Unsafe route "...": segments must not be ".", "..", ...`**
A route (usually derived from a CMS slug) contained path-traversal segments that would write outside `outDir`. Sanitize the slug in your `route()` mapping; hybld refuses rather than write outside the output directory.

**`Cannot find module 'node:path'` inside `next build`**
Next's bundler processed the hybld module graph. Checklist: `serverExternalPackages: ["hybld", "@hybld/next", "jiti"]` in next.config, helpers imported from `@hybld/next` (not deep paths), and a **`.mjs`** hybld config (TS configs cannot load inside Next build workers).

**Rollup/Vite error about `fsevents.node` or binary files during `astro build`**
Astro's SSR bundle tried to bundle the hybld graph. Add `vite: { ssr: { external: ["hybld", "@hybld/astro", "<your adapter package>", "jiti"] } }` to astro.config.

**`framework build emitted no file for this route`**
The framework built but the expected output file is missing. On Next, `trailingSlash: true` is required (route/index.html layout). Also verify the page's `hybldParams`/`hybldPaths` maps `job` fields to the same params your `route()` produces.

**`gc skipped: live asset graph(s) without a recorded file list`**
Pages in the manifest predate GC support for their graph, or (delegated) the site ships no hashed assets at all. In the first case, rebuild those pages; in the second, there is genuinely nothing to collect.

**`Draft previews are not supported on the <next|astro> backend`**
By design: each preview would cost a full framework build. Use the framework's own draft/preview mode.

**Serve returns `503 {"status":"regenerating"}`**
Expected on delegated backends with `--regen`: the page is building asynchronously (a framework build must not block the request). Retry after the indicated delay.

## Behavior questions

**A page shows stale content even though the CMS changed.**
The skip decision hashes `data()`. If the page renders content fetched outside `data()` (possible on Next/Astro), that content is invisible to hashing. Either derive everything from `data()` or force with `hybld build --routes <route> --force`.

**The homepage didn't update after an edit.**
Is `"/"` in the article's `dependents`? On delegated backends the home page refreshes on every framework run regardless; on react-vite it rebuilds only when listed as a dependent and its data hash changed.

**Deep archive pages are stale after a publish.**
Bounded archive rebuilds: dependents with `{ type, id, depth }` rebuild only the first `depth` pages (default 3). Raise `depth` or accept staleness on deep pagination.

**`next dev` / `astro dev` doesn't reflect hybld config or CMS changes.**
Dev servers cache the full-catalog config per process; restart the dev server. (The full-catalog enumeration is also memoized for 60s within a process, so a plain `next build` does not re-walk the catalog on every page.)

**A scheduled `--since last-build` sweep missed some edits.**
The `last-build` cursor advances only on `--all` and `--since` runs that had zero failures. Targeted, chunked, limited, and `reconcile` runs deliberately leave it untouched, so a real `--since` sweep always covers everything modified since the last real sweep. If edits are still missed, check that your adapter's `listModifiedSince` uses the same timezone as the modification timestamps.

**Everything rebuilt when I only changed app code.**
Correct: a new asset graph makes pages code-stale, and `--all` rebuilds them. To converge gradually instead, deploy code, then run `hybld build --stale --chunk-size N` on a schedule.

**CMS requests seem too low in the summary.**
Per-run memoization deduplicates identical GETs within a build, and the summary counts requests made through helper-built adapters (`adapter.fetcher`); hand-written adapters using their own fetch are not counted.

**Disk cache: when is it safe?**
`cms.cache` trades freshness (within its TTL) for CMS load. Modified-since and trash queries always bypass it, but listing data used by aggregate loaders can be up to TTL stale. Use it for bulk full/chunked rebuild campaigns; keep it off for webhook-driven incremental sites.

## Environment notes

- Node >= 22.5 required (`node:sqlite`). The "SQLite is an experimental feature" warning is harmless.
- Windows is untested.
- With pnpm, packages not declared as dependencies of your app are not resolvable from it (intentional isolation); declare what you import.
