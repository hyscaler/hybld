---
title: "CLI"
description: "Every hybld command and flag, exit codes, and the changed-files report."
sidebar:
  order: 2
---
All commands read `hybld.config.*` from the current directory (override with `--config <path>`).

## `hybld build`

Exactly one scope selector per invocation (`--chunk-size` may also accompany `--stale` as a batch limit):

```bash
hybld build --all [--clean]                 # full catalog + aggregates; --clean empties outDir first
hybld build --limit <n>                     # first n items per collection (smoke test)
hybld build --chunk <i>/<n>                 # deterministic slice i of n (parallel CI full builds)
hybld build --chunk-size <n>                # next n never-built pages
hybld build --routes /a/,/b/                # explicit routes (manifest, singleton, or match-resolved)
hybld build --slugs s1,s2                   # by CMS slug
hybld build --ids 5,author:12               # by CMS id; "type:" prefix targets other collections
hybld build --since last-build              # incremental: CMS modified/deleted since last build
hybld build --since 2026-07-19T00:00:00Z    # incremental from an explicit time
hybld build --stale [--chunk-size <n>]      # converge code-stale pages after an app deploy
```

Shared flags:

| Flag | Effect |
| ------ | -------- |
| `--dry-run` | Print the computed scope (including dependents and deletions) without building. |
| `--force` | Ignore content-hash skipping. |
| `--no-dependents` | Do not rebuild listing pages affected by the scope. |
| `--fail-fast` | Abort on the first page failure (default: record and continue; exit code 2). |
| `--concurrency <n>` | Engine-side evaluation/render concurrency. |
| `--wait` | Wait for the build lock instead of failing when another build is running. |
| `--json` | Machine-readable summary on stdout. |
| `--verbose` | Progress logging to stderr. |
| `--config <path>` | Explicit config file. |

Exit codes: `0` success, `1` fatal/config error, `2` completed with page failures.

Every build ends by refreshing the sitemap and feed (when enabled), saving the redirects map, updating the manifest metadata, and writing the changed-files report to `.hybld/last-build.json`:

```json
{
  "mode": "since last-build",
  "built": ["/articles/new-post/"],
  "skipped": [], "failed": [], "deleted": [], "moved": [],
  "dependentsRebuilt": ["/", "/category/tech/"],
  "files": { "created": [...], "updated": [...], "deleted": [...] }
}
```

## `hybld status [--reconcile [--prune]]`

Page counts by type, code-stale count, last build times. `--reconcile` additionally sweeps every collection's full ID list from the CMS and reports orphan routes (deleted in the CMS but still built). Add `--prune` to delete them through the normal build pipeline: files, manifest rows, dependent archive pages, sitemap and feed all update. This is the deletion path for adapters without `listDeletedSince`.

## `hybld preview --slugs <s1,s2> | --ids <id1,id2>`

Renders unpublished drafts (via the adapter's `getPreview`, e.g. WordPress `status=any`) to `<outDir>/_preview/...` with a `noindex, nofollow` robots meta tag. Not recorded in the manifest or sitemap. React + Vite backend only; delegated backends error with guidance to use the framework's own draft mode.

## `hybld serve [--port 4600] [--host 127.0.0.1] [--secret <s>] [--static] [--regen]`

Long-running server over a warm builder (builds queue and coalesce):

| Endpoint | Behavior |
| ---------- | ---------- |
| `POST /rebuild` | JSON body with any build scope (`{"slugs": ["x"]}`, `{"since": "last-build"}`, ...). Returns the build summary. |
| `POST /webhook/wordpress` | Accepts common WP publish payload shapes (`post_id`, `post.ID`, `id`) and runs a targeted build. |
| `GET /healthz` | Liveness. |

Binds to `127.0.0.1` by default. Binding wider (`--host 0.0.0.0`) requires `--secret` (or an explicit `--insecure`), because the POST endpoints trigger real builds. `--secret <s>` requires an `x-hybld-secret` header on POSTs (compared timing-safe); request bodies are capped at 1 MB.

`--static` serves the output directory. `--regen` enables regeneration on miss for routes resolvable via `pages.*.match`: the react-vite backend builds inline and serves the page; delegated backends return `503` with `Retry-After: 15` and rebuild asynchronously (a framework build must never block an HTTP request). Regen is abuse-guarded: routes that produce nothing are negative-cached for 60 seconds and at most 8 distinct routes regenerate concurrently (extras get `503`).

## `hybld sync <targetDir> [--delete] [--redirects netlify|nginx]`

Applies the last build's changed-files report to a target directory: copies created/updated files, deletes removed ones with `--delete`, and emits a host redirects file (`_redirects` or `redirects.nginx.map`) from the redirects map. For S3/CDN deploys, consume `.hybld/last-build.json` directly with your CLI of choice and invalidate exactly the listed paths.

## `hybld assets gc [--dry-run]`

Deletes hashed asset files (in the backend's asset dirs: `assets/`, `_next/static/`, `_astro/`) that no built page's asset graph references anymore. Refuses to run if any live graph predates GC support (or if pages ship no hashed assets at all, in which case there is nothing to collect).

## `hybld manifest ...`

```bash
hybld manifest export <file.json>    # manifest -> JSON (inspection, portability)
hybld manifest import <file.json>    # JSON -> manifest
hybld manifest merge <other.db>      # merge another manifest; newest builtAt wins per route
hybld manifest push --url <url>      # HTTP PUT the .db (S3 presigned URLs work)
hybld manifest pull --url <url>      # HTTP GET, replacing the local .db
```

Merge is how parallel chunked CI jobs combine their results: each job builds its slice with its own manifest, a final job merges them.
