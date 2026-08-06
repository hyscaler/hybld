---
title: "Deployment & Operations"
description: "Webhooks, serve mode, deploy diffs, redirects, chunked CI builds, and code-deploy convergence."
sidebar:
  order: 1
---
## The operational pattern

Three mechanisms cover publishing end to end:

1. **Push (webhooks)**: the CMS notifies `hybld serve` (or your own server using the API) on publish/update; only the affected pages rebuild, within seconds.
2. **Pull (cron sweep)**: `hybld build --since last-build` on a schedule catches scheduled posts going live and any missed webhooks. This sweep is a required companion to webhooks, not optional. Weekly, add `hybld status --reconcile --prune` to remove pages for deletions your CMS cannot report. The `last-build` cursor only advances on `--all` and `--since` runs, so targeted or chunked builds in between never make the sweep skip updates.
3. **Deploy diff**: after every build, `.hybld/last-build.json` lists exactly which files were created, updated, and deleted; ship only those.

## serve mode

```bash
hybld serve --port 4600 --secret "$WEBHOOK_SECRET" [--static] [--regen]
```

- `POST /rebuild` with any build scope as JSON; `POST /webhook/wordpress` for standard WP publish payloads; `GET /healthz`.
- Builds queue and coalesce: an editor saving five times in a minute triggers one rebuild of that page.
- `--static` serves the output dir (with your 404 page for misses). `--regen` adds ISR-style regeneration for routes resolvable through `pages.*.match`: inline on the react-vite backend, async with a `503 Retry-After` response on Next/Astro backends. Unresolvable routes are negative-cached for 60s and concurrent regens are capped, so a flood of bogus URLs cannot spawn unbounded builds.
- Security: the server binds `127.0.0.1` by default. To accept webhooks from another host, set `--secret` and bind wider (`--host 0.0.0.0`); a non-loopback bind without a secret is refused unless you pass `--insecure`. The secret is compared in constant time and request bodies are capped at 1 MB.

Example webhook wiring from WordPress: any webhook plugin POSTing the post ID to `https://build.internal/webhook/wordpress` with the `x-hybld-secret` header, to a server started with `hybld serve --host 0.0.0.0 --secret "$WEBHOOK_SECRET" --static`.

## Deploying the output

**To a directory / rsync-style target:**

```bash
hybld sync /var/www/site --delete --redirects nginx
```

Copies only the last build's changed files, deletes removed ones, and writes `redirects.nginx.map` from the slug-change map. `--redirects netlify` writes a `_redirects` file instead.

**To S3/CDN**: read the report and act on exactly those paths:

```bash
report=.hybld/last-build.json
jq -r '.files.created[], .files.updated[]' $report | while read f; do
  aws s3 cp "dist/$f" "s3://my-bucket/$f"
done
jq -r '.files.deleted[]' $report | while read f; do aws s3 rm "s3://my-bucket/$f"; done
jq -r '[.files.created[], .files.updated[], .files.deleted[]] | .[]' $report \
  | sed 's|^|/|' | xargs -n 500 aws cloudfront create-invalidation --distribution-id $DIST --paths
```

## Redirects (slug changes)

Renaming an article's slug is detected as a move: the old page is removed, the new one built, and `old -> new` recorded in `.hybld/redirects.json` (cumulative, chain-collapsed). Serving the redirects is the host's job; `hybld sync --redirects` emits Netlify and nginx formats.

## Sitemap and RSS

Both regenerate from the manifest on every build with no extra CMS calls: the sitemap as an index plus shards of at most 50,000 URLs, the feed from per-article entries captured at build time. Only shards whose content changed are rewritten (and therefore appear in the deploy report).

## Full builds at scale: chunked CI

```bash
# ten parallel jobs, each with its own manifest
hybld build --chunk $i/10
# a final job combines them
hybld manifest merge job1.db && hybld manifest merge job2.db && ...
hybld status   # zero pending confirms completion
```

Chunks slice a stable ordering (collection, then id ascending), so items published mid-build cannot shift the slices; a follow-up `--since` picks them up. Share manifests between jobs with `hybld manifest push/pull --url <presigned-url>`.

## App code deploys (code-staleness)

Deploying new app code does not force an immediate full rebuild: previously built pages keep working against the old hashed assets (append-only). Converge on your schedule:

```bash
hybld build --stale --chunk-size 50000    # nightly, until `hybld status` shows code-stale: 0
hybld assets gc                            # afterwards: delete asset files nothing references
```

## Performance characteristics

Measured with the engine benchmark (`node scripts/bench.mjs <count>` in the repo: synthetic catalog, trivial renderer, so numbers isolate engine cost from framework render time). On a laptop:

| Operation | 50k pages | 200k pages |
| ----------- | ----------- | ------------ |
| Full build (engine + file writes) | ~8s (~6,400 pages/s) | ~35s (~5,700 pages/s) |
| No-change sweep (`--all`, everything skips) | ~1.4s | ~4.2s |
| Incremental publish/edit (1 article) | ~0.1s | ~0.5s |

What makes it fast, and what to know:

- **One SQLite transaction per run** (WAL journal, cached prepared statements): page records commit in bulk instead of one fsync per page.
- **Parallel catalog fetches**: when the adapter reports a count, listing pages are fetched concurrently (bounded by `cms.concurrency`); real CMS round-trips benefit far more than the in-memory benchmark shows.
- **Sitemap and feed regenerate only when the page set changed**, so no-op sweeps stay cheap.
- Incremental cost grows mildly with catalog size (the sitemap regenerates from the full manifest when pages change); at 1M pages expect roughly 1 to 2 seconds of engine overhead per publish.
- On delegated backends the framework build dominates (`astro build` seconds, `next build` a handful more); the engine overhead above is additive. Persist the framework's own cache (`.next/cache`) across CI runs, and set `eslint.ignoreDuringBuilds`/`typescript.ignoreBuildErrors` in next.config if lint/type-check time matters in scoped builds (Next telemetry is already disabled by the backend).
- For giant first builds, spread the work with [chunked CI](#full-builds-at-scale-chunked-ci); after that, everything is incremental.

## Locking and concurrency

One build mutates a project at a time: a lock file next to the manifest, stale-lock recovery for crashed processes, `--wait` to queue a CLI invocation behind a running build. Parallel chunked jobs are the sanctioned exception (disjoint slices, separate manifests, merged afterwards).
