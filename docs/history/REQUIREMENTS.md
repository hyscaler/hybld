# hybld: Requirements Document

> Historical design document, kept for context. It records the plan as written before implementation and is not maintained; where it differs from the code or the docs site, the code and docs are correct.

Incremental and selective static site builds for React + Vite projects backed by a headless CMS.

Status: Draft v2 (revised after scale and gap analysis)
Date: 2026-07-20

## 1. Overview

`hybld` is an npm package (CLI + programmatic Node API) that manages the static build of a React + Vite site whose content lives in a CMS (for example WordPress). Instead of always rebuilding every page, it lets teams build:

- everything (full build),
- a limited number of articles (limited build),
- a slice of the catalog (chunked build, resumable),
- specific pages by URL, slug, or article ID (targeted build),
- only what changed since the last build (incremental build).

Every build writes each generated HTML page to its correct path inside the output folder without disturbing pages that were not part of the build.

## 2. Problem Statement

A typical setup: a CMS holds around 1,000,000 articles. The React + Vite frontend pulls article data at build time and prerenders one HTML page per article.

With a traditional static build this causes three problems:

1. **Build time.** Every build fetches and renders all pages, even when only one article changed. At 1M articles this can take many hours.
2. **CMS rate limits.** Fetching the entire catalog in one run hammers the CMS API and triggers rate limiting or outright failures.
3. **Wasted work on publish.** Publishing a single new article forces a complete rebuild of pages whose content did not change.

The desired behavior: after an initial full build (possibly performed in chunks across multiple runs), publishing or editing one article should require building only that article's page (plus any listing pages that reference it), and the result should be dropped into the existing output folder at the right path.

## 3. Goals

- G1: Provide full, limited, chunked, targeted, and incremental build modes through one consistent interface.
- G2: Ship a built-in prerenderer so the package works on any React + Vite project without requiring Vike, React Router framework mode, or another SSG framework.
- G3: Be CMS-agnostic through a small adapter interface; ship generic REST and GraphQL adapter helpers for conventional APIs, with a WordPress preset built on the REST helper as the reference implementation.
- G4: Track build state in a persisted manifest so incremental builds can auto-detect new, updated, and deleted articles.
- G5: Protect the CMS with configurable concurrency, batching, retries with backoff, and response caching.
- G6: Support partial output updates: write only the pages that were built, never wipe the rest of the output directory.
- G7: Expose a programmatic API so webhook handlers and custom scripts can trigger single-page builds.

## 4. Non-Goals (v1)

Status note (v0.3): these were the v1 scoping decisions. NG1, NG2, NG3, and NG5 were subsequently revisited and implemented in v0.3 (see section 11 for what shipped); NG4 was softened to a deploy-agnostic `sync` primitive rather than provider SDK integrations.

- NG1: No Vite plugin mode (`vite build` integration) in v1; the CLI and API are the entry points.
- NG2: No runtime rendering or ISR-style on-demand regeneration server.
- NG3: No built-in webhook listener server; the programmatic API must make it trivial to build one, but hosting it is the user's concern.
- NG4: No deploy/CDN integration (S3, Cloudflare, Netlify). hybld ends at the output directory.
- NG5: No CMS-specific adapter presets beyond WordPress in v1. Other CMSes are served by the generic REST/GraphQL helpers or a hand-written inline adapter; dedicated presets (Strapi, Contentful, Sanity) come later.

## 5. Terminology

| Term | Meaning |
| ------ | --------- |
| Article | A content item in the CMS (post, page, product, etc.). |
| Route | The URL path a page is served at, for example `/articles/my-post/`. |
| Page | The prerendered HTML output for one route. |
| Adapter | Implementation of the CMS data-source interface for a specific CMS. |
| Manifest | Persisted build state (a SQLite file, see FR-8) describing what was built, when, and from which content version. |
| Chunk | One slice of the full route list, identified as `i/n` (chunk i of n) or by a fixed size. |
| Incremental build | A build whose scope is computed by diffing the manifest against the CMS modified/deleted feeds. |
| Dependent page | A page whose content is derived from many articles (listing page, category page, sitemap) and must refresh when any member article changes. |
| Aggregate page | A page type built from many articles (home, category archive, 404) that declares its own data loader, as opposed to one-page-per-article collection pages. |
| Code-stale | A built page whose HTML references an older asset graph (app code) than the current build; its content is current but its code is old. |

## 6. Functional Requirements

### FR-1: Full build

Build every route known to the configuration (all articles from the adapter plus all static and dependent pages).

Acceptance criteria:
- `hybld build --all` fetches the complete catalog through the adapter using paginated requests (never one giant request).
- Produces one HTML file per route in the output directory.
- Writes/updates the manifest for every built route.
- Memory use stays bounded regardless of catalog size (streaming, see NFR-3).

### FR-2: Limited build

Build only the first N articles (by adapter-defined default ordering, typically newest first) plus requested static pages.

Acceptance criteria:
- `hybld build --limit 500` builds at most 500 article pages.
- Useful for previews, smoke tests, and CI validation without a full run.
- Manifest entries are written only for the routes actually built.

### FR-3: Chunked build

Split the full route list into deterministic chunks so a full build can be spread across multiple processes or CI runs, and resumed after interruption.

Acceptance criteria:
- `hybld build --chunk 3/10` builds the third of ten equal slices of the route list. Slices are computed over a stable ordering (article ID ascending, never newest-first) so articles published while a multi-hour chunked build is running do not shift the slices and cause overlaps or gaps; anything published mid-build is picked up by a follow-up `--since` build.
- `hybld build --chunk-size 5000` is the size-based alternative: hybld consults the manifest, takes the next 5000 unbuilt (or stalest) routes, builds them, and records progress.
- Chunked runs can execute in parallel on separate machines as long as they target different chunks; each run only appends/updates its own manifest entries (see FR-8 for merge behavior).
- `hybld status` reports how many routes are built, pending, and stale, so operators know when the chunked full build is complete.

### FR-4: Targeted build

Build an explicit set of pages identified by route, slug, or CMS article ID.

Acceptance criteria:
- `hybld build --routes /articles/my-new-post/,/about/` builds exactly those routes.
- `hybld build --slugs my-new-post` and `hybld build --ids 84213` resolve articles through the adapter (`getArticle`) and build their mapped routes.
- Nonexistent targets fail with a clear per-target error and a non-zero exit code, without aborting the other targets (summary lists succeeded/failed targets).
- Built pages land at their mapped output paths; no other files in the output directory are modified.

### FR-5: Incremental build

Build only what changed since the last recorded build.

Acceptance criteria:
- `hybld build --since last-build` reads the last successful build timestamp from the manifest, calls the adapter's `listModifiedSince(date)`, and builds only the returned articles' routes.
- `hybld build --since 2026-07-19T00:00:00Z` accepts an explicit ISO timestamp.
- New articles (present in CMS, absent from manifest) are detected and built.
- Updated articles are rebuilt only if their CMS modified date or content hash differs from the manifest entry (unchanged articles are skipped even if returned by the feed).
- Deleted articles are handled per FR-9.
- Dependent pages affected by the changed articles are rebuilt per FR-10.
- `--dry-run` prints the computed build scope (routes to add, update, delete) without building.
- Articles scheduled to become public at a future time only appear once a build runs after that time; a periodic `--since last-build` sweep (cron) is therefore a required companion to webhook-driven builds, not just a convenience.

### FR-6: Built-in prerenderer

hybld owns the SSG step so it works on any React + Vite project.

Acceptance criteria:
- The user provides an SSR entry module (configured as `render.entry`) that default-exports a render function: given `{ route, data }` it returns `{ html, head }`, where `html` is the page body markup (via `react-dom/server`) and `head` is the per-page head fragment: `<title>`, meta description, canonical URL, Open Graph and Twitter tags, and optional JSON-LD. hybld provides a documented helper (a `<Head>` collector component) so pages can declare head tags declaratively instead of assembling strings.
- Per-page head injection is mandatory v1 scope: SEO metadata is the primary reason to prerender, so a release without per-page titles and meta tags is not shippable.
- hybld runs the Vite client build and the Vite SSR build once per invocation, then renders each in-scope route by calling the SSR bundle with that route's data.
- Output is hydration-ready: the rendered body and head are injected into the project's `index.html` template together with the correct client script/CSS tags and a serialized data payload (for example `window.__HYBLD_DATA__`) so the client bundle can hydrate.
- Render errors are isolated per page: a component that throws for one article marks that page as failed in the summary and manifest, and the run continues. Same policy as fetch failures in FR-11; `--fail-fast` applies to render errors too.
- Shared assets (JS/CSS chunks) are content-hashed by Vite and written to the shared assets directory. A targeted or incremental build must not change the asset URLs referenced by pages that were not rebuilt. Assets are append-only: an app-code change produces new hashed bundles alongside the old ones, previously built pages keep working against the old assets, and their manifest rows become code-stale (see FR-16 for how they converge onto the new code).
- Respects Vite's `base` option so sites served under a subpath (for example `/blog/`) get correct asset and link URLs.
- Rendering runs in a worker pool with configurable parallelism.

### FR-7: CMS adapter interface and generic adapter helpers

A minimal, paginated, CMS-agnostic data-source contract. The interface is the core abstraction; generic helper factories cover conventional APIs so most users never write an adapter by hand.

Required interface (TypeScript):

```ts
interface CmsAdapter<TArticle = unknown> {
  name: string;
  count(): Promise<number>;
  listArticles(opts: { page: number; perPage: number }): Promise<{
    items: TArticle[];
    hasMore: boolean;
  }>;
  getArticle(ref: { id?: string | number; slug?: string }): Promise<TArticle | null>;
  // Optional: required for `--since` incremental builds. If absent, hybld
  // reports the capability as missing and `--since` fails with guidance to
  // use targeted builds or reconciliation instead.
  listModifiedSince?(date: Date, opts: { page: number; perPage: number }): Promise<{
    items: TArticle[];
    hasMore: boolean;
  }>;
  // Optional: CMSes that expose deletions. If absent, deletions are found
  // by full reconciliation (hybld status --reconcile).
  listDeletedSince?(date: Date): Promise<Array<{ id: string | number; slug?: string }>>;
  // Optional: taxonomy terms (categories, tags) so aggregate pages can
  // enumerate archives. Exposed to page data loaders via the `cms` helper.
  listTerms?(taxonomy: string): Promise<Array<{ id: string | number; slug: string; name: string }>>;
}
```

Generic helpers (shipped in the core package):

```ts
import { createRestAdapter, createGraphqlAdapter } from "hybld/adapters";

// Conventional REST APIs: describe the endpoint conventions, get a full adapter.
const rest = createRestAdapter({
  listUrl: "https://api.example.com/articles",
  itemUrl: (ref) => `https://api.example.com/articles/${ref.slug ?? ref.id}`,
  pageParam: "page",
  perPageParam: "per_page",
  modifiedAfterParam: "modified_after",   // omit if the API cannot filter by date
  count: { header: "X-Total-Count" },      // or { url, pick } or a custom function
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
});

// GraphQL endpoints: user supplies the queries and result pickers,
// the helper handles pagination, throttling, and retries.
const gql = createGraphqlAdapter({
  endpoint: "https://cms.example.com/graphql",
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
  list: { query: LIST_QUERY, pick: (r) => r.articles.nodes, pageInfo: (r) => r.articles.pageInfo },
  item: { query: ITEM_QUERY, pick: (r) => r.article },
  modifiedSince: { query: MODIFIED_QUERY, pick: (r) => r.articles.nodes }, // optional
});
```

Acceptance criteria:
- The core never talks to a CMS directly; all content access goes through an adapter.
- `createRestAdapter(options)` produces a complete `CmsAdapter` for conventional REST APIs: configurable pagination params, modified-after param, count strategy (header, endpoint, or function), and auth headers.
- `createGraphqlAdapter(options)` produces a complete `CmsAdapter` from user-supplied queries and result pickers, supporting cursor and offset pagination. GraphQL is a transport, not a schema, so the queries themselves always come from the user.
- Both helpers route their HTTP traffic through the shared rate-limit layer (FR-11) so retries, throttling, and caching apply uniformly.
- Adapters declare their capabilities implicitly by which optional methods they implement; hybld degrades gracefully and with clear messaging when `--since` or deletion detection is requested from an adapter that cannot support it.
- The WordPress adapter (`@hybld/adapter-wordpress`) is a thin preset (roughly 50 lines) built on `createRestAdapter`, wiring WordPress conventions (`modified_after`, `X-WP-Total`, `_embed`, taxonomy endpoints for `listTerms`). It is the reference implementation and integration test bed, proving the helper handles a real production API.
- Unusual APIs fall back to hand-written adapters: any object satisfying the interface can be provided inline in the config file.

### FR-8: Build manifest

Persisted state enabling incremental builds, chunk resume, and status reporting.

Storage decision: a single JSON file does not scale to this catalog size. At 1,000,000 routes an entry-per-route JSON manifest is roughly 200 MB; parsing it takes seconds and atomically rewriting the whole file after every built page would dominate build time. The manifest is therefore a SQLite database (single file, default `.hybld/manifest.db`): transactional per-page updates, indexed queries such as "next N unbuilt routes" and "routes with a stale asset graph", and still one artifact that CI can cache. `hybld manifest export` / `import` convert to and from JSON for inspection and portability.

Logical record (one row per route):

```json
{
  "route": "/articles/my-new-post/",
  "articleId": 84213,
  "slug": "my-new-post",
  "contentHash": "c41d8b02",
  "cmsModifiedAt": "2026-07-20T09:28:44Z",
  "builtAt": "2026-07-20T09:32:09Z",
  "assetGraphHash": "9f2c1ab4",
  "outputPath": "articles/my-new-post/index.html"
}
```

Global metadata rows track `lastFullBuildAt`, `lastBuildAt`, the current asset graph hash, and the manifest schema version.

Acceptance criteria:
- Manifest location is configurable; the file is designed to persist via CI cache or object storage (see OQ-1).
- Every successful page build commits its row transactionally; a crashed build never corrupts the manifest and never loses previously committed rows.
- Manifest read/write cost stays proportional to the pages built in that run, never to total catalog size: a one-page incremental build touches one row.
- Per-route `assetGraphHash` records which code version rendered each page, enabling the code-staleness queries behind FR-16.
- Concurrent chunked runs on different chunks each produce a manifest; `hybld manifest merge <fileA> <fileB>` combines them, newest `builtAt` winning per route.
- Builds are idempotent: re-running the same scope with unchanged content results in skips (reported), not rewrites.

### FR-9: Output management and deletions

Acceptance criteria:
- Each route maps to a deterministic output path (default `<outDir>/<route>/index.html`); mapping is configurable per page type.
- Page writes are atomic and additive: building `/articles/new-post/` creates or replaces only that file (plus new shared assets); sibling pages and assets are untouched.
- hybld never clears the output directory unless explicitly asked (`hybld build --all --clean`).
- "Deleted" means no longer publicly visible: trashed, unpublished, and made-private articles all count as deletions from the static site's point of view, and adapters must treat them uniformly.
- When an incremental build detects a deleted article (via `listDeletedSince` or reconciliation), it removes the page file and directory, removes the manifest row, rebuilds dependent pages and the affected sitemap shard, and logs the removal.
- A changed slug is a move, not a delete-plus-create; moves are handled per FR-17 including a redirect entry.
- `hybld status --reconcile` performs a full ID sweep against the adapter to find deletions for CMSes that cannot report them, without rebuilding anything; `--prune` additionally deletes the orphans through the normal pipeline (files, manifest, dependents, sitemap/feed).
- Routes are sanitized before writing: "." and ".." segments are rejected, and all writes/deletes are contained to the output directory (CMS-controlled slugs must not be able to escape it).

### FR-10: Dependent-page regeneration

Adding, updating, or deleting one article usually affects more than its own page: the home/listing page, category and tag pages, paginated archives, RSS, and the sitemap.

Acceptance criteria:
- The config can declare dependent page rules: given a changed article, return the additional routes or page groups to rebuild. A rule may return a group selector such as `{ type: "category", id: a.categorySlug, depth: 3 }` meaning "the first 3 pages of that category archive", because a plain route list cannot express paginated archives.
- Paginated archives are a declared hard case with an explicit default policy. Inserting one article at the top of an archive shifts an item onto every subsequent page, so a naive dependents rule would rebuild hundreds of pages. Default: bounded rebuilds (rebuild the first `depth` pages of the affected archive, default 3, tolerating staleness on deeper pages). Opt-in alternative for sites needing exact deep pagination: stable ascending page numbering, where page 1 holds the oldest content and new articles only ever touch the newest pages.
- Sitemap generation is built in, incremental, and sharded: hybld maintains a sitemap index plus shard files of at most 50,000 URLs each (the sitemap protocol limit; 1M articles is roughly 20 shards). A single-article build rewrites only the affected shard and the index, from the manifest, without re-fetching the catalog.
- Incremental and targeted builds automatically include the dependent routes computed from their scope; `--no-dependents` opts out.

### FR-11: Rate-limit management

Acceptance criteria:
- Configurable: `concurrency` (parallel CMS requests, default 4), `perPage` batch size (default 100), `requestsPerSecond` throttle (optional).
- Automatic retry with exponential backoff and jitter on 429/5xx responses; a `Retry-After` header, when present, overrides the backoff delay (seconds and HTTP-date forms).
- A per-request timeout (default 30s) so a hung CMS connection fails the request instead of stalling the build, and a pagination guard that aborts if the CMS returns identical consecutive pages.
- Optional local response cache (`.hybld/cache/`) keyed by request URL + article modified date, so re-runs and dependent-page rebuilds do not re-fetch unchanged data.
- A run that exhausts retries fails that page (recorded in the summary and left unbuilt/stale in the manifest) rather than aborting the whole run; `--fail-fast` opts into aborting.

### FR-12: CLI

Commands:

```
hybld build --all [--clean]
hybld build --limit <n>
hybld build --chunk <i>/<n>
hybld build --chunk-size <n>
hybld build --routes <r1,r2,...>
hybld build --slugs <s1,s2,...>
hybld build --ids <id1,id2,...>
hybld build --since last-build | <ISO date>
hybld build --stale [--chunk-size <n>]
hybld status [--reconcile]
hybld manifest merge <fileA> <fileB> [-o <out>]
hybld manifest export | import <file>
```

Shared flags: `--config <path>`, `--out-dir <path>`, `--concurrency <n>`, `--dry-run`, `--no-dependents`, `--fail-fast`, `--wait` (wait for the build lock instead of failing, see FR-15), `--json` (machine-readable summary), `--verbose`.

Acceptance criteria:
- Exactly one scope selector (`--all`, `--limit`, `--chunk`, `--chunk-size`, `--routes`/`--slugs`/`--ids`, `--since`, `--stale`) is required for `build`; combining incompatible selectors is an error. One sanctioned combination: `--chunk-size` may accompany `--stale` as a batch limiter, as shown in the command list.
- Exit codes: 0 all pages succeeded, 1 configuration/fatal error, 2 completed with some page failures.
- End-of-run summary: pages built, skipped (unchanged), failed, deleted, moved, dependent pages rebuilt, total CMS requests, duration, and the path of the changed-files report (FR-18).

### FR-13: Programmatic API

```ts
import { createBuilder, defineConfig } from "hybld";

const builder = await createBuilder({ configFile: "./hybld.config.ts" });

// Same scopes as the CLI:
await builder.build({ all: true });
await builder.build({ limit: 500 });
await builder.build({ chunk: { index: 3, total: 10 } });
await builder.build({ routes: ["/articles/my-new-post/"] });
await builder.build({ since: "last-build" });
await builder.build({ stale: true, chunkSize: 20000 });

const report = await builder.status();
await builder.close();
```

Acceptance criteria:
- Every CLI capability is available through the API; the CLI is a thin wrapper over it.
- `build()` resolves with the same summary object the CLI prints with `--json`.
- The builder can stay warm (Vite SSR bundle loaded) between `build()` calls, so a webhook server can rebuild a single page in seconds.
- The builder maintains an internal build queue: `build()` calls made while a build is running are queued rather than run concurrently, and queued requests targeting the same routes are coalesced. An editor saving five times in one minute produces one rebuild of that page, not five (see FR-15).
- Typical webhook usage fits in a few lines: receive CMS publish event, call `builder.build({ ids: [event.postId] })`.

### FR-14: Configuration file

`hybld.config.ts` at the project root, loaded by CLI and API:

```ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";

export default defineConfig({
  adapter: wordpress({
    baseUrl: "https://cms.example.com",
    postType: "posts",
    auth: { token: process.env.WP_TOKEN },
  }),
  outDir: "dist",
  basePath: "/",                      // optional; defaults to Vite's `base` (subpath hosting)
  manifest: ".hybld/manifest.db",
  render: {
    entry: "src/entry-server.tsx",   // default-exports render({ route, data }) => { html, head }
    template: "index.html",
    workers: 4,
  },
  cms: {
    concurrency: 4,
    perPage: 100,
    cache: true,
  },
  pages: {
    // Collection page type: one page per article from the adapter.
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => a,                 // shape passed to render()
      dependents: (a) => [
        "/",
        { type: "category", id: a.categorySlug, depth: 3 },
      ],
    },
    // Aggregate page types: pages whose data spans many articles.
    // Each declares its own enumeration, routing, pagination, and data loading.
    home: {
      route: () => "/",
      data: async ({ cms }) => ({ latest: await cms.list({ perPage: 20 }) }),
    },
    category: {
      enumerate: async ({ cms }) => cms.listTerms("category"),
      paginate: { perPage: 20 },
      route: (c, page) => (page > 1 ? `/category/${c.slug}/page/${page}/` : `/category/${c.slug}/`),
      data: async (c, page, { cms }) => ({
        category: c,
        items: await cms.list({ category: c.id, page, perPage: 20 }),
      }),
    },
    notFound: {
      route: () => "/404.html",       // emitted at the output root for static hosts
      data: () => ({}),
    },
  },
  sitemap: { enabled: true, baseUrl: "https://www.example.com" },
  redirects: { file: ".hybld/redirects.json" },   // slug-change redirect map (FR-17)
});
```

Acceptance criteria:
- Config is validated on load with actionable error messages (unknown keys, missing adapter, missing render entry).
- Two kinds of page types are supported. Collection pages produce one page per adapter item. Aggregate pages (home, category archives, 404) declare their own `enumerate`, `route`, optional `paginate`, and `data` loaders. Aggregate pages are first-class build targets; this is what makes dependent-page regeneration (FR-10) actually buildable rather than a list of routes nothing knows how to render.
- Aggregate `data` loaders receive a `cms` helper that wraps the adapter with the shared rate-limit layer and response cache, so listing queries respect the same throttling as catalog fetches.
- A `notFound` page type emits `404.html` at the output root, which static hosts serve for unknown paths.
- `route`, `data`, `dependents`, and `enumerate` are plain functions, so any URL scheme and data shape is supported.

### FR-15: Concurrency control and build locking

Only one build may mutate a project's output and manifest at a time.

Acceptance criteria:
- Every build acquires a project-level lock (lock file next to the manifest). A second CLI invocation fails fast with a clear message by default, or waits for the lock with `--wait`.
- The warm builder (FR-13) serializes builds through its internal queue and coalesces queued requests targeting the same routes, so webhook bursts (an editor saving repeatedly, two articles published at once, a webhook overlapping the nightly sweep) produce the minimum number of sequential builds and never a concurrent write.
- Stale locks from crashed processes are detected (PID plus heartbeat timestamp) and cleared safely.
- Parallel chunked CI runs are the sanctioned exception: they operate on disjoint route slices with separate manifests and output staging, merged afterwards (FR-3, FR-8).

### FR-16: Code-stale rebuilds

An app-code deployment must not require an immediate full rebuild, but all pages must eventually converge onto the new code.

Acceptance criteria:
- When the Vite build produces a new asset graph hash, previously built pages keep working (append-only assets, FR-6) but their manifest rows no longer match the current hash and are counted as code-stale.
- `hybld build --stale [--chunk-size <n>]` re-renders code-stale pages in bounded batches, oldest `builtAt` first, so repeated cron runs progressively bring the whole catalog onto the new code without one giant build.
- `hybld status` reports code-stale counts separately from content-stale counts.
- Rebuilding a page for any reason always uses current code, so a content-driven rebuild also clears that page's code-staleness.

### FR-17: Slug and URL changes

Renaming an article must not silently break its old URL.

Acceptance criteria:
- When a build resolves an article whose ID exists in the manifest under a different route, hybld treats it as a move: it builds the new route, removes the old page file and manifest row, and appends `old route -> new route` to the redirects map file (location configurable, default `.hybld/redirects.json`, optionally mirrored into the output directory).
- The redirects map is cumulative across builds and chain-collapsed: a to b followed by b to c is stored as a to c.
- Consuming the map is the host's job (nginx map, Netlify `_redirects`, CDN edge rules); hybld ships documented examples for common hosts but no deploy integration (NG4).
- Dependent pages and the sitemap shards affected by the move are rebuilt in the same run.

### FR-18: Changed-files report

Every build must tell the outside world exactly what it touched, so deployment can sync and invalidate only that.

Acceptance criteria:
- After each build, hybld writes a machine-readable report (default `.hybld/last-build.json`) listing files created, updated, and deleted (pages, new assets, sitemap shards, redirects map), plus the build summary.
- The report enables precise CDN invalidation and rsync/S3 sync of only the changed paths; with `--json` the same payload is printed to stdout.
- The report is per-run and overwritten each build; long-term build history is out of scope for v1.

## 7. Non-Functional Requirements

- NFR-1: TypeScript, published with type declarations; ESM-first with the CLI as a bin entry.
- NFR-2: Supports Node >= 20 and Vite >= 5 (exact matrix finalized at implementation time).
- NFR-3: Bounded memory: article catalogs are consumed as paginated streams; the full 1M-article set is never held in memory at once.
- NFR-4: Resumable: any interrupted run can be re-executed; the manifest plus idempotent writes guarantee no duplicate or lost work.
- NFR-5: Observable: structured logs, progress reporting for long runs (built X of Y), and a machine-readable JSON summary for CI.
- NFR-6: Tested: unit tests for scope resolution and manifest diffing; integration test against a mock WordPress REST server; an end-to-end fixture project (React + Vite) exercising every build mode.
- NFR-7: Performance target: on the fixture project, an incremental build for one new article (warm builder) completes in under 10 seconds excluding CMS latency; per-page render throughput scales with the worker count.
- NFR-8: Scale-tested: an automated benchmark with a synthetic catalog of at least 1,000,000 mock articles validates that incremental build cost is proportional to pages built (not catalog size), that chunked full builds behave correctly, and that memory stays bounded.
- NFR-9: Secrets hygiene: CMS auth tokens come from environment variables and are never written into the manifest, the response cache, logs, or the changed-files report.

## 8. High-Level Architecture

```
CLI (hybld ...)            Programmatic API (createBuilder)
        \\                       /
         Orchestrator (scope resolver: all/limit/chunk/targets/since/stale)
          |            |             |              |
     CmsAdapter    Manifest      Prerenderer     OutputWriter
     (WordPress,   store         (Vite client+   (atomic page
      custom)      (SQLite:      SSR build,      writes, deletes,
                   diff, merge)  worker pool)    sitemap, redirects)
```

Flow: the orchestrator acquires the project build lock (FR-15), resolves the build scope into a route list (using the manifest and adapter), the prerenderer ensures fresh client/SSR bundles, workers render each route with adapter-fetched data, the output writer places HTML atomically, the manifest is updated per page, and the changed-files report (FR-18) is written before the lock is released.

## 9. Technology Stack

Language: **TypeScript on Node**, and this is a requirement rather than a preference. hybld must execute the user's JavaScript: it renders their React components through `react-dom/server`, calls the functions in their `hybld.config.ts` (`route`, `data`, `dependents`, inline adapters), and drives Vite's Node API for the client and SSR builds. A Go or Rust core was considered and rejected: it would still need Node embedded or shelled out for all of the above, while the actual build bottlenecks (CMS network I/O and V8 rendering time) are unaffected by the orchestrator's language. Compiled-language rewrites of hot paths remain possible later as native addons if profiling ever justifies it.

Repository: **pnpm workspaces** monorepo.

| Package | Purpose |
| --------- | --------- |
| `packages/hybld` | Core: CLI, programmatic API, prerenderer, manifest, generic adapter helpers. |
| `packages/adapter-wordpress` | WordPress preset built on `createRestAdapter`. |
| `examples/demo-site` | React + Vite fixture app; doubles as the end-to-end test bed. |

Build and development tooling: **tsup** (ESM bundles + type declarations per package), **Vitest** (tests), **Biome** (lint and format), **Changesets** (versioning and npm publishing).

Runtime dependencies, mapped to the requirements they serve:

| Concern | Choice | Serves |
| --------- | -------- | -------- |
| CLI parsing | citty | FR-12 |
| Config loading | unconfig (TS config files) | FR-14 |
| Config validation | zod | FR-14 actionable errors |
| Manifest store | better-sqlite3 | FR-8 |
| Render worker pool | tinypool | FR-6 |
| HTTP client | undici | FR-7, FR-11 |
| Concurrency/throttle | p-queue + small backoff util | FR-11 |
| Build lock | proper-lockfile | FR-15 |
| Logging | consola | NFR-5 |

Peer dependencies, never bundled: `vite`, `react`, `react-dom`. The host project already provides them, and bundling our own copies would cause version conflicts. Supported targets per NFR-2: Node >= 20, Vite >= 5, React 18 and 19 (`renderToString` first; streaming rendering can arrive later without changing the render contract).

Testing infrastructure: a mock WordPress REST server built with **Hono** runs in-process for integration tests, including 429 responses to exercise the backoff logic; the same mock generates synthetic articles on the fly for the 1M-article scale benchmark (NFR-8), so no giant fixture files are stored in the repo.

Known trade-off: better-sqlite3 is a native module (prebuilt binaries on install). If zero native dependencies ever becomes a requirement, Node 22's built-in `node:sqlite` is the fallback at the cost of raising the minimum Node version (see OQ-6).

## 10. Example Workflows

**Initial full build in chunks (CI):** ten parallel CI jobs each run `hybld build --chunk i/10`, each producing its own manifest (FR-15); a final job combines them with `hybld manifest merge` and runs `hybld status` to confirm zero pending routes.

**New article published:** a CMS webhook calls a small server that runs `builder.build({ ids: [84213] })`. hybld fetches that one article, renders `/articles/my-new-post/`, writes `dist/articles/my-new-post/index.html`, rebuilds the home and category listing pages, updates the sitemap, and records everything in the manifest. Total CMS requests: a handful, not one million.

**Nightly catch-up:** cron runs `hybld build --since last-build` to sweep up any edits missed by webhooks and any scheduled posts that went live, followed by `hybld status --reconcile` weekly to catch deletions.

**App code deployed:** the next build produces a new asset graph hash. All previously built pages keep serving against the old (append-only) assets. Nightly `hybld build --stale --chunk-size 50000` runs converge the catalog onto the new code over the following days, while webhook builds use the new code immediately.

**Deploy sync:** after any build, the deploy script reads `.hybld/last-build.json` and syncs only the listed created/updated files to the server or CDN, deletes the removed ones, and invalidates exactly those cache paths.

## 11. Roadmap Status

Implemented in v0.3:

- Webhook listener server: `hybld serve` with `POST /rebuild`, `POST /webhook/wordpress`, secret auth, and optional static hosting.
- On-demand ISR-style regeneration: `hybld serve --static --regen` resolves unknown routes via `pages.article.match` and builds them on request.
- CMS presets built on the generic helpers: Strapi (`@hybld/adapter-strapi`), Contentful (`@hybld/adapter-contentful`), Sanity (`@hybld/adapter-sanity`), each unit-tested against API-shaped mock servers.
- Per-page `data.json` (`emitData: true`), enabling client-side navigation without CMS calls.
- RSS feed (`feed` config), maintained incrementally from feed entries stored in the manifest at build time.
- Image localization (`images` config): CMS-hosted images referenced in rendered HTML are downloaded into the output and their URLs rewritten.
- Draft preview builds: `hybld preview --slugs/--ids` renders unpublished articles to a noindexed `/_preview/` path (WordPress preset implements `getPreview` via `status=any`).
- Asset garbage collection: `hybld assets gc [--dry-run]`, backed by asset-graph file lists recorded per build; refuses to run when a live graph predates GC support.
- Vite plugin mode (experimental): `hybld()` from `hybld/plugin` makes plain `vite build` prerender the site.
- Deploy sync primitive: `hybld sync <dir> [--delete] [--redirects netlify|nginx]` applies the changed-files report; provider SDK integrations remain out of scope by design (the report + any CLI covers S3/CDN).
- Manifest sharing over HTTP: `hybld manifest push/pull --url` (works with S3 presigned URLs), the minimal form of a distributed manifest backend.
- Cross-run disk response cache (opt-in `cms.cache`), bypassed automatically for modified-since and trash queries.

Implemented in v1.0:

- Multi-framework support via pluggable render backends: owned React + Vite backend, delegated Next.js (App Router and Pages Router) and Astro backends via `@hybld/next` and `@hybld/astro`; design and deviations recorded in MULTI-FRAMEWORK-PLAN.md at the repo root.
- Multiple adapter-backed collection page types (`collection: true` with optional per-collection adapters for authors/products/etc.; `pages.article` remains a collection by default).

Still future:

- Image optimization (resizing, responsive variants): requires a native imaging dependency such as sharp.
- A true distributed manifest backend (live shared Redis/S3 store with locking, beyond push/pull snapshots).
- First-class i18n (works today via locale-aware route functions; no dedicated helpers).
- Turbopack support for the Next backend (webpack builds only today), and additional frameworks (Vue, Svelte, Nuxt) as new render backends.

## 12. Open Questions

- OQ-1: Where should the manifest live in CI for this team: CI cache or object storage? SQLite is a binary file, so committing it to git works but diffs poorly. (Affects the chunk-merge workflow.)
- OQ-2 (resolved): app-code changes are handled with append-only assets plus progressive `--stale` rebuilds (FR-6, FR-16). Remaining sub-question: the retention policy for superseded assets, meaning when old hashed bundles can be garbage-collected safely (parked in the roadmap).
- OQ-3: Are multi-locale routes (i18n) needed in v1, or is one locale per site acceptable initially?
- OQ-4: Should `--limit`/ordering be configurable (newest first versus adapter order)?
- OQ-5: Is 3 pages the right default depth for bounded archive rebuilds (FR-10) given this team's archive layouts?
- OQ-6: Manifest driver: better-sqlite3 (native module, works on Node 20) or Node 22's built-in `node:sqlite` (zero native deps, higher Node floor)? Decision for v0.1: `node:sqlite` (zero install friction; the Manifest class isolates the driver so swapping to better-sqlite3 for Node 20 support is a small change).

## 13. Suggested Milestones

| Version | Scope |
| --------- | ------- |
| v0.1 (MVP) | Config with collection and aggregate page types, adapter interface + `createRestAdapter` helper + WordPress preset, prerenderer with per-page head/meta, SQLite manifest, full/limited/targeted builds, atomic output writes, build locking, 404 page. |
| v0.2 | Chunked builds with resume/merge, incremental `--since` diffing, `createGraphqlAdapter` helper, response cache, rate-limit backoff, changed-files report. |
| v0.3 | Dependent-page regeneration with bounded archive rebuilds, deletion/unpublish handling, slug-change redirects, sharded incremental sitemap, `status --reconcile`, code-stale `--stale` rebuilds. |
| v1.0 | Warm programmatic builder with build queue and coalescing for webhook use, JSON summaries, 1M-article scale benchmark, docs, adapter authoring guide, stability hardening. |
