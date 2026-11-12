---
title: "Scaling to Large Catalogs"
description: "The production playbook for 100k to 1M+ pages: rate-limit budgeting, chunked first builds, manifest strategy, steady-state publishing, and recovery."
sidebar:
  order: 2
---
Everything in hybld is designed around one asymmetry: the **first** build touches every page, and every build after it touches almost none. This page is the playbook for surviving the first build at large scale and running the steady state reliably. Numbers below assume the measured engine throughput (~6,000 pages/s engine-side; your CMS and renderer add their own costs).

## Phase 0: budget the CMS, not the CPU

At catalog scale the bottleneck is virtually never rendering; it is **CMS API round-trips**. Budget them before the first build:

```
list calls   = catalog_size / cms.perPage          (1M articles / 100 = 10,000 calls)
term calls   = one per taxonomy
data calls   = 0 extra if data() derives from the list payload (recommended)
```

Rules that keep the budget sane:

- **Derive `data()` from the list item.** The adapters fetch full objects in list calls; if `data(a)` only reads fields of `a`, a 1M-article build costs ~10k requests, not 1M. Reach for per-item fetches inside `data()` only when the list payload truly lacks something, and know you are multiplying the budget by the catalog size.
- Set `cms.perPage` to the CMS's maximum (WordPress: 100).
- Set `cms.concurrency` to what the CMS tolerates (start at 4 to 8), and add `cms.requestsPerSecond` if the CMS has a hard rate limit. 429s and 5xx are retried with backoff honoring `Retry-After` automatically, but staying under the limit beats retrying past it.
- For bulk rebuild campaigns (not steady state), enable the disk cache: `cms: { cache: { ttlSeconds: 3600 } }`. Repeat list calls across chunked jobs then hit disk, not the CMS. Keep it off for webhook-driven steady state (it trades freshness).
- Aggregate loaders share a per-run memo: five category pages calling `cms.list({ category_slug })` with identical params cost one request.

## Memory

Catalog-wide builds (`--all`, `--chunk`, `--chunk-size`, `--since`) stream the CMS listing: articles are fetched, rendered, written and recorded in windows of 2,000, and each window is released before the next. Memory use depends on the window, not on the catalog. As a reference point, a single `--all` over 300,000 articles of 30 KB each completes inside a 400 MB Node heap.

Two things to know:

- On the framework backends (Next.js, Astro, SvelteKit, Nuxt) a window is one framework build of at most `render.batchSize` pages (default 5000, or `--batch-size`). A scope that fits in one batch, such as a published article and its listings, is still exactly one framework build.
- The manifest is checkpointed after every window, so a crashed first build resumes where it stopped when you rerun the same command.

## Phase 1: the first full build

**Up to ~100k pages: one job.** A single `hybld build --all` is typically CMS-bound; at 8 concurrent requests and 100/page, a 100k catalog lists in ~2 to 5 minutes plus render time. Do a `--limit 500` smoke test first, check the summary and a few output files, then run `--all`.

**Beyond that: chunk it across CI jobs.** Each item belongs to a chunk by a hash of its collection and id, so N jobs partition the catalog exactly, each job streams the listing and keeps only its own items, and items published mid-build cannot move existing ones between chunks (a follow-up `--since` picks them up):

```yaml
# GitHub Actions sketch: 10-way chunked first build
jobs:
  chunk:
    strategy: { matrix: { i: [1,2,3,4,5,6,7,8,9,10] } }
    steps:
      - run: npx hybld build --chunk ${{ matrix.i }}/10 --json > summary-${{ matrix.i }}.json
      - run: npx hybld manifest push --url "$MANIFEST_STORE/chunk-${{ matrix.i }}.db"
      # ship each job's output slice to the host/bucket as well
  merge:
    needs: chunk
    steps:
      - run: |
          for i in $(seq 1 10); do
            npx hybld manifest pull --url "$MANIFEST_STORE/chunk-$i.db" && mv .hybld/manifest.db chunk-$i.db
            npx hybld manifest merge chunk-$i.db
          done
      - run: npx hybld build --since last-build   # catch anything published mid-build
      - run: npx hybld status                     # sanity: totals match the catalog
```

Sizing chunks: aim for jobs of 30 to 90 minutes. A 1M-page catalog at ~200 pages/s per job (CMS-bound, conservative) is ~85 minutes across 10 jobs. On delegated backends (Next/Astro), remember each chunk run also pays one framework build; the chunk count matters less than keeping each framework build's page count in the tens of thousands.

**Framework backends: batch the framework build.** A scope larger than `render.batchSize` (default 5000) is split across several `next build`, `astro build`, `vite build` (SvelteKit) or `nuxi generate` runs in one command, each merged as it finishes. Tune the size to what your framework handles comfortably:

```bash
hybld build --all --batch-size 5000
```

The manifest is checkpointed after every batch. If the machine dies in batch 14 of 20, rerun the same command: the first 13 batches are skipped and the build resumes from there. Each batch pays the framework's fixed startup cost, so prefer a few thousand pages per batch over a few hundred. Batching and chunking combine: chunk across CI jobs for wall-clock time, batch within each job to keep every framework build small. On the Pages Router, pages built in early batches carry older build ids than `keepBuildIds` retains, so client-side navigation to them falls back to a full page load until they are next rebuilt.

**Disk math.** Page HTML dominates: 1M pages at 30 to 100 KB each is 30 to 100 GB in `outDir`, plus the manifest (~1 row per page; a 1M-row manifest is a few hundred MB) and sitemap shards (20 files at 50k URLs each). Provision the build host accordingly; the output can live on cheap storage since deploys ship diffs.

## Phase 2: manifest strategy

The manifest (`.hybld/manifest.db`) is the single source of truth for what exists. Losing it does not corrupt the site, but the next build re-renders everything it cannot account for. Pick one home for it:

| Strategy | How | Fits |
| ---------- | ----- | ------ |
| Persistent build host | it just stays on disk next to the project | the common case: one VM/container runs webhooks + cron |
| Object storage | `hybld manifest push/pull --url <presigned S3 URL>` around every CI job | ephemeral CI runners |
| CI cache | cache `.hybld/` keyed on something stable | simple setups; beware eviction (an evicted manifest = full rebuild) |

Rules: one writer at a time (the build lock enforces this per directory; chunked jobs use separate manifests merged afterwards), and back the manifest up on the same cadence as you would dread re-running a full build.

## Phase 3: steady state

The daily loop at any scale is the same three mechanisms (details in [Deployment](/operate/deployment/)):

1. **Webhooks** for seconds-fast publishes: `hybld serve` with a secret, CMS webhook pointed at it. Queue coalescing absorbs editor bursts.
2. **Cron `--since last-build`** every 5 to 15 minutes as the safety net: scheduled posts, missed webhooks, adapter-reported deletions. At 1M pages a no-change sweep costs a few list calls plus ~5s of engine time.
3. **Weekly `status --reconcile --prune`** for CMSes that cannot report deletions: a full ID sweep (same list-call budget as Phase 0, ~10k calls at 1M) that removes orphaned pages through the normal pipeline.

Steady-state costs at 1M pages, measured engine characteristics:

| Event | Cost |
| ------- | ------ |
| Publish/edit one article (owned backend) | ~1 to 2s total: the page + dependents render in ms; sitemap-shard regeneration dominates |
| Publish/edit one article (Next/Astro) | above + one framework build (seconds) |
| No-change `--since` sweep | seconds: a few CMS list calls + manifest scan |
| App-code deploy | zero immediate cost; converge with `--stale` (below) |

**Sitemap note at 1M**: the sitemap regenerates from the full manifest whenever the page set changes, ~1 to 2s per publish at 1M pages. It is the largest fixed cost per publish; if your publish rate is very high (many per minute), batch webhooks aggressively so the cost is paid per batch, not per article.

## App-code deploys at scale

Deploying new app code never forces an immediate full rebuild. Old pages keep working against the old hashed assets (append-only); converge on your schedule:

```bash
# nightly until `hybld status` reports code-stale: 0
hybld build --stale --chunk-size 50000
# then reclaim superseded assets
hybld assets gc
```

A `--stale` run picks the cheaper way to reach the CMS on its own: when many pages are stale it walks the listing (about one request per 100 articles), and when only a few are left it fetches those by id.

At 1M pages and 50k/night, full convergence takes 20 nights while the site stays consistent throughout, or run bigger chunks on quiet hours. Users see the new code on rebuilt pages first; unchanged pages keep the old (still-deployed) assets until their turn.

## Monitoring and operational hygiene

- Every build returns a machine-readable summary with `--json` (also written to `.hybld/last-build.json`): `built`, `skipped`, `failed` (with per-route errors), `deleted`, `moved`, `cmsRequests`, `durationMs`. Alert on `failed.length > 0` and on cron sweeps that stop running.
- Exit codes: `0` success, `2` completed with page failures, `1` hard error. Cron + `--json` + exit-code checks is a complete monitoring story.
- `hybld status` is cheap and reports totals by page type, code-stale count, and last build times; a scheduled check that totals roughly match your CMS count catches drift.
- `GET /healthz` on serve mode for liveness probes.
- Failed pages hold the `--since` cursor back, so the next sweep retries them automatically; persistent failures (a malformed article that crashes your renderer) show up as the same route failing in consecutive summaries.

## Failure and recovery

- **Crash mid-build**: the manifest commits in one transaction per run; a killed process rolls back cleanly and file removals are journaled and replayed on the next run. Just re-run the same command.
- **Wiped or lost `outDir`**: the manifest notices missing output files and re-renders them on the next relevant build; `hybld build --all` restores everything (renders are cheap; the CMS list calls are the cost).
- **Wiped or lost manifest**: hybld snapshots the manifest to `<manifest>.bak` after builds (see `manifestBackup`) and restores it automatically when the manifest is missing or unreadable; the next `--since last-build` then catches up on anything built after the snapshot. If the snapshot is gone too, `hybld manifest adopt` re-records every page that already has an output file without rendering it, which costs the CMS listing instead of a full rebuild. Keep an off-host copy with `hybld manifest push` as well: the snapshot lives on the same disk as the manifest.
- **Suspected drift** (site does not match CMS): `hybld status --reconcile` reports orphans without changing anything; `--prune` removes them; `hybld build --all` is the full re-sync (unchanged pages skip by hash, so it is mostly list calls plus a no-op sweep).
- **Force a page**: `hybld build --routes /articles/x/ --force` bypasses the hash check for one page.

## Scale checklist

Before the first big build: `data()` derives from list payloads; `cms.perPage` maxed; concurrency/rate matched to the CMS; disk sized for the catalog; manifest home chosen; `--limit 500` smoke test green. For steady state: webhook + cron + reconcile all scheduled; `--json` summaries collected; manifest backed up; framework cache persisted (delegated backends); `--stale` convergence scheduled for code deploys.
