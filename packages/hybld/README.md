# hybld

**Build one page, not a million.**

hybld is incremental static site generation for CMS-backed sites. It keeps a SQLite manifest of every page it has built; when your CMS changes, it rebuilds only what actually changed: the edited article, the listings and archives that reference it, the sitemap, and the RSS feed. A site with a million articles no longer pays a full-catalog rebuild (and a full round of CMS rate limits) to publish a single post.

```
                      ┌──────────────── hybld ────────────────┐
CMS (WordPress,       │ manifest: what exists, content hashes │      static host
 Strapi, Contentful,  │ diff: what changed since last build?  │      (S3/CDN, nginx,
 Sanity, any REST/    │ scope: article + its listing pages    │───>  Netlify, CF Pages)
 GraphQL API)    ───> │ render: React+Vite | Next.js | Astro  │      ships only the
                      │ post: sitemap, feed, redirects, diff  │      changed files
                      └────────────────────────────────────────┘
```

Works on three frameworks: **React + Vite** (hybld renders pages itself: millisecond warm rebuilds), **Next.js** and **Astro** (hybld scopes the framework's own build to just the changed pages via [@hybld/next](https://www.npmjs.com/package/@hybld/next) and [@hybld/astro](https://www.npmjs.com/package/@hybld/astro)).

Requires Node >= 22.5 (uses the built-in `node:sqlite`).

## Contents

- [Quickstart (React + Vite)](#quickstart-react--vite)
- [The config](#the-config)
- [Build scopes](#build-scopes)
- [What every build maintains](#what-every-build-maintains)
- [Running in production](#running-in-production)
- [Programmatic API](#programmatic-api)
- [CMS adapters](#cms-adapters)
- [Configuration reference](#configuration-reference)
- [CLI reference](#cli-reference)
- [At scale](#at-scale)
- [Troubleshooting](#troubleshooting)

## Quickstart (React + Vite)

The default backend needs only this package plus an adapter. Four files wire it up.

```bash
npm install -D hybld @hybld/adapter-wordpress
```

**1. `hybld.config.ts`** (see [The config](#the-config) below for the full anatomy):

```ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL, trackDeletes: true }),
  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({ title: a.title.rendered, html: a.content.rendered, date: a.date }),
      dependents: () => ["/"],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({
        latest: (await cms.list({ perPage: 10 })).map((a) => ({ slug: a.slug, title: a.title.rendered })),
      }),
    },
  },
  sitemap: { enabled: true, baseUrl: "https://www.example.com" },
});
```

**2. `index.html`**: two placeholders:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!--app-head-->
  </head>
  <body>
    <div id="root"><!--app-html--></div>
    <script type="module" src="/src/entry-client.tsx"></script>
  </body>
</html>
```

**3. `src/entry-server.tsx`**: the render function hybld calls once per page (in a worker pool):

```tsx
import { renderToString } from "react-dom/server";
import { ArticlePage } from "./pages/ArticlePage";
import { HomePage } from "./pages/HomePage";

export const PAGES: Record<string, React.ComponentType<any>> = {
  article: ArticlePage,
  home: HomePage,
};

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export default function render({ route, pageType, data }: { route: string; pageType: string; data: any }) {
  const Page = PAGES[pageType];
  const html = renderToString(<Page {...data} />);
  // The head fragment is where SEO lives: title, description, canonical, OG, JSON-LD.
  const head = [
    `<title>${esc(data.title ?? "My Site")}</title>`,
    `<link rel="canonical" href="https://www.example.com${route}">`,
  ].join("\n    ");
  return { html, head };
}
```

**4. `src/entry-client.tsx`**: hydration from the payload hybld injects into every page:

```tsx
import { hydrateRoot } from "react-dom/client";
import { PAGES } from "./entry-server";

const p = (window as any).__HYBLD_DATA__;   // { route, pageType, data }
if (p) hydrateRoot(document.getElementById("root")!, <PAGES[p.pageType] {...p.data} />);
```

Then:

```bash
npx hybld build --all          # first full build: every page, sitemap, feed
npx hybld build --all          # again: everything skips, sub-second
# publish an article in the CMS, then:
npx hybld build --since last-build   # builds: the article + the home page. Nothing else.
```

Server and client render the same component from the same serialized data, so there is no hydration mismatch by construction. For Next.js and Astro wiring, see the [@hybld/next](https://www.npmjs.com/package/@hybld/next) and [@hybld/astro](https://www.npmjs.com/package/@hybld/astro) pages, which are equally complete.

## The config

Two ideas carry the whole system:

**`data()` is the unit of change.** hybld hashes each page's `data()` result; a page rebuilds only when that hash changes (or its file is missing, or your app code changed). Corollary: everything a page renders must derive from `data()`. Content fetched elsewhere is invisible to hashing and will go stale.

**`dependents()` is the blast radius.** It declares which listing pages an article affects. Archives are bounded: `{ type: "category", id: ..., depth: 2 }` rebuilds the first 2 pages of that archive (inserting an article shifts something onto every deeper page; bounded depth trades tolerable staleness deep in the archive for not rebuilding hundreds of pages).

Three kinds of page:

| Kind | Declared by | Examples |
| ------ | ------------- | ---------- |
| Collection | `route(a)` + `data(a)` (the key `article` is a collection by default; others add `collection: true`) | one page per article, per author, per product |
| Singleton aggregate | `route()` + `data(ctx)` | home, about |
| Enumerated aggregate | `enumerate(ctx)` + `route(item, page)` + `data(item, page, ctx)`, optional `paginate`/`pageCount` | category/tag archives with pagination |

The `cms` helper passed to aggregate loaders wraps your adapter with rate limiting and per-run memoization: `cms.list(opts)`, `cms.listTerms(taxonomy)`, `cms.getArticle(ref)`, `cms.count()`.

## Build scopes

Every build has exactly one scope:

| Scope | Meaning |
| ------- | --------- |
| `--all` | Full catalog plus all aggregates. Unchanged pages skip by hash, so re-running is cheap. |
| `--since last-build` (or an ISO date) | Everything the CMS reports modified since then, plus deletions when the adapter supports them. The daily driver. |
| `--slugs a,b` / `--ids 1,2` / `--routes /x/` | Explicit targets (what a webhook handler uses). `--ids author:5` targets a non-default collection. |
| `--limit N` | First N items (smoke tests). |
| `--chunk i/n` | Deterministic slice of the catalog, for spreading a first build across parallel CI jobs. |
| `--chunk-size N` | The next N never-built pages (resumable first builds). |
| `--stale` | Pages rendered by an older version of your app code (see below). |

Modifiers: `--force` (bypass hash skipping), `--dry-run` (list what would build), `--no-dependents`, `--fail-fast`, `--clean`, `--json`, `--wait` (queue behind a running build), `--concurrency N`.

**Deletions**: adapters that can report them (WordPress with `trackDeletes`) handle deletions inside `--since`: page files removed, dependents rebuilt, sitemap/feed updated, slug changes become redirects. For CMSes that cannot, `hybld status --reconcile --prune` does a full ID sweep and removes orphans through the same pipeline.

**App-code deploys**: new code does not force an immediate rebuild. Old pages keep working against the old hashed assets (the assets directory is append-only); `hybld build --stale --chunk-size 50000` converges on your schedule, then `hybld assets gc` reclaims superseded assets.

## What every build maintains

- **Sharded sitemap**: index plus files of at most 50,000 URLs, regenerated from the manifest whenever the page set changes.
- **RSS feed** (`feed.xml`) from per-article entries captured at build time.
- **Redirects map** from slug changes (`.hybld/redirects.json`, chain-collapsed); `hybld sync --redirects netlify|nginx` emits host formats.
- **Changed-files report** (`.hybld/last-build.json`): exactly which files were created, updated, deleted, so deploys ship only the diff.
- **Image localization** (opt-in `images: { origins: [...] }`): CMS-hosted images referenced by pages are downloaded into the output and URLs rewritten, so the static site does not hotlink the CMS.

## Running in production

The pattern is push + pull + diff:

```bash
# PUSH: webhooks for seconds-fast publishes
hybld serve --host 0.0.0.0 --port 4600 --secret "$WEBHOOK_SECRET" --static
```

| Endpoint | Behavior |
| ---------- | ---------- |
| `POST /rebuild` | Any build scope as JSON: `{"slugs": ["x"]}`, `{"since": "last-build"}`. Returns the summary. |
| `POST /webhook/wordpress` | Standard WP publish payloads (`post_id`), runs a targeted build. |
| `GET /healthz` | Liveness. |

Builds queue and coalesce (an editor saving five times in a minute triggers one rebuild). Security: loopback bind by default, a wider bind requires the secret (constant-time compared), request bodies capped at 1 MB. `--static` serves the output dir; `--regen` adds ISR-style regeneration on miss for routes resolvable through `pages.*.match` (rate-guarded).

```bash
# PULL: the cron safety net (scheduled posts, missed webhooks, deletions)
*/10 * * * *  npx hybld build --since last-build --json >> /var/log/hybld.log
0 3 * * 0     npx hybld status --reconcile --prune

# DIFF: ship only what changed
hybld sync /var/www/site --delete --redirects nginx
# or push .hybld/last-build.json's file lists to S3/CDN and invalidate exactly those paths
```

Exit codes: `0` clean, `2` completed with page failures (per-route errors in the JSON summary), `1` hard error. Failed pages hold the incremental cursor back, so the next sweep retries them automatically.

## Programmatic API

Everything the CLI does, via a **warm builder** (artifacts stay loaded between builds, so webhook rebuilds cost milliseconds of overhead):

```ts
import { createBuilder } from "hybld";

const builder = await createBuilder({ wait: true });   // ONE per process, reuse it

const summary = await builder.build({ ids: [postId] });
// { built: string[], skipped, failed: [{route, error}], deleted,
//   moved: [{from, to}], cmsRequests, durationMs, reportPath, ... }

if (summary.failed.length) alert(summary.failed);      // per-page failures do NOT throw
await builder.status();                                // totals, code-stale count, timestamps
await builder.reconcile({ prune: true });              // remove CMS-side deletions
await builder.preview({ slugs: ["draft-post"] });      // noindexed draft render (react-vite)
await builder.close();                                 // always, on shutdown
```

Per-page failures land in `summary.failed` and the batch continues; run-level failures (bad config, CMS down past retries) reject the promise. `startServer(builder, opts)` is the serve mode as a library.

## CMS adapters

Presets: [@hybld/adapter-wordpress](https://www.npmjs.com/package/@hybld/adapter-wordpress) (the most complete: modified-since, deletions, taxonomies, previews), [@hybld/adapter-strapi](https://www.npmjs.com/package/@hybld/adapter-strapi), [@hybld/adapter-contentful](https://www.npmjs.com/package/@hybld/adapter-contentful), [@hybld/adapter-sanity](https://www.npmjs.com/package/@hybld/adapter-sanity). Each package page documents its options and capability matrix.

For any conventional API, the generic helpers:

```ts
import { createRestAdapter, createGraphqlAdapter } from "hybld/adapters";

const adapter = createRestAdapter({
  listUrl: "https://api.example.com/articles",
  perPageParam: "per_page",
  modifiedAfterParam: "modified_after",          // enables --since
  count: { header: "X-Total-Count" },            // enables parallel catalog listing
  pickList: (body) => body.items,
  headers: { Authorization: `Bearer ${process.env.TOKEN}` },
});
```

Or implement the interface directly (`count`, `listArticles`, `getArticle`, optional `listModifiedSince`/`listDeletedSince`/`listTerms`/`getPreview`). All helper-built adapters share one HTTP layer: bounded concurrency, optional requests/second throttle, retry with backoff honoring `Retry-After`, per-run memoization, optional cross-run disk cache.

## Configuration reference

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `adapter` | required | The CMS adapter. |
| `pages` | required | The content model (see above). |
| `renderer` | react-vite | `nextRenderer()` / `astroRenderer()` from the framework packages, or a custom backend. |
| `outDir` | `dist` | Cumulative static output (delegated backends: must differ from the framework's own dir). |
| `manifest` | `.hybld/manifest.db` | SQLite manifest location. |
| `render.entry` / `render.template` | `src/entry-server.tsx` / `index.html` | React + Vite entries. |
| `render.workers` | 4 | Render worker threads (crashed workers respawn; hung renders time out per `render.timeout`, default 60s). |
| `cms.concurrency` / `cms.perPage` / `cms.requestsPerSecond` | 4 / 100 / off | CMS request budget. |
| `cms.cache` | off | Cross-run disk cache for bulk rebuild campaigns (modified-since queries always bypass it). |
| `sitemap` / `feed` / `redirects` | see above | Maintained artifacts. |
| `images` | off | CMS image localization: `{ origins: [...], dir: "media" }`. |
| `emitData` | false | Write `data.json` next to every page (client-side navigation without CMS calls). |
| `basePath`, `root`, `preview.pathPrefix` | `/`, config dir, `/_preview` | Occasional needs. |

## CLI reference

| Command | Purpose |
| --------- | --------- |
| `hybld build <scope> [modifiers]` | The builds (see [Build scopes](#build-scopes)). |
| `hybld serve [--port --host --secret --static --regen]` | Webhook server / static hosting / regen-on-miss. |
| `hybld status [--reconcile [--prune]] [--json]` | Totals by type, code-stale count, last build times; reconcile finds (and with `--prune`, removes) CMS-side deletions. |
| `hybld preview --slugs s1,s2` | Render drafts to a noindexed `/_preview/` path (react-vite backend). |
| `hybld sync <dir> [--delete] [--redirects netlify\|nginx]` | Apply the changed-files report to a directory; emit redirect files. |
| `hybld assets gc [--dry-run]` | Delete hashed assets no live page references. |
| `hybld manifest export\|import <file> \| merge <db> \| push\|pull --url <u>` | Manifest transport for chunked CI and backups. |

## At scale

Engine throughput (measured, synthetic renderer): ~6,000 pages/s full build, ~4s no-change sweep at 200k pages, 0.1 to 0.5s incrementals. The practical bottleneck is CMS round-trips, so the one rule that matters: **derive `data()` from the list payload**, so a 1M-article build costs ~10k list calls, not 1M item fetches.

For 100k+ catalogs: chunk the first build across CI jobs (`--chunk i/10` slices a stable ordering; merge manifests afterwards with `hybld manifest merge`), give the manifest a durable home (`manifest push/pull --url <presigned S3>` for ephemeral CI), and expect ~1 to 2s of sitemap regeneration per publish at 1M pages (batch webhook bursts). Everything after the first build is incremental forever.

## Troubleshooting

| Symptom | Fix |
| --------- | ----- |
| `hybld config not found` | Run from the project root or pass `--config`. Next projects: the config must be `.mjs`. |
| `index.html is missing the <!--app-html--> placeholder` | Add both placeholders (react-vite backend). |
| `Another hybld build is running` | Use `--wait` to queue; stale locks from crashes clear themselves. |
| `--since last-build requires a previous build` | Run any scope once first; the cursor only starts after a completed `--all`/`--since`. |
| A page shows stale content | Something it renders does not derive from `data()`; move it into `data()` or `--force` the route. |
| `render of <route> timed out` | A render hung (default limit 60s); raise `render.timeout` or fix the awaited call. |
| Everything rebuilt after a code deploy | Expected as `--stale` convergence, not on content builds. If content builds rebuild everything, your `data()` returns something unstable (timestamps, random order). Make it deterministic. |
| Deletions never happen | Adapter lacks `listDeletedSince`: schedule `hybld status --reconcile --prune`. |

## License

MIT
