# hybld

Incremental and selective static builds for React + Vite, Next.js, and Astro projects backed by a headless CMS.

**Documentation is a Starlight site in [`docs/`](./docs/)**: getting started, concepts, configuration and CLI references, per-framework guides, adapters, deployment, the programmatic API, backend authoring, and troubleshooting. Run it locally with `cd docs && npm install && npm run dev`, or read the markdown sources directly in `docs/src/content/docs/`. Project history: `REQUIREMENTS.md` (engine spec) and `MULTI-FRAMEWORK-PLAN.md` (multi-framework architecture).

## Repo layout

| Path | What it is |
| ------ | ------------ |
| `packages/hybld` | Engine: CLI, programmatic API, render backends, SQLite manifest, adapter helpers, serve/sync tooling, Vite plugin. |
| `packages/next` | `@hybld/next`: Next.js backend (static export) plus `hybldParams`/`hybldData` helpers. |
| `packages/astro` | `@hybld/astro`: Astro backend plus `hybldPaths`/`hybldData` helpers. |
| `packages/adapter-wordpress` | WordPress REST preset (previews, trash-driven deletions). |
| `packages/adapter-strapi` | Strapi v4/v5 preset. |
| `packages/adapter-contentful` | Contentful Delivery API preset. |
| `packages/adapter-sanity` | Sanity (GROQ) preset. |
| `examples/demo-site` | React + Vite demo app plus the mock WordPress CMS used by all demos. |
| `examples/next-demo` | Next.js App Router (`output: "export"`) demo. |
| `examples/nextpages-demo` | Next.js Pages Router demo (getStaticPaths/getStaticProps). |
| `examples/astro-demo` | Astro demo. |

Requires Node >= 22.5 (uses the built-in `node:sqlite`) and pnpm.

## Two rendering strategies

**Owned (react-vite, the default)**: hybld runs the Vite client + SSR builds and renders every page itself. Warm single-page rebuilds in milliseconds; hybld controls head tags, hydration payloads, and previews.

**Delegated (next, astro)**: hybld computes what changed, writes the scope to `.hybld/scope.ndjson`, runs the framework's own build (whose dynamic routes read the scope through the helper packages), then merges the emitted pages and hashed assets into its cumulative output dir. Each incremental run costs one framework build (Astro ~1s, Next ~5s in the demos), still nothing like a full rebuild at scale. The framework owns head tags and its 404 page; draft previews are react-vite only; every batch carries all singleton pages plus at least one page per dynamic route type (Next's export refuses an empty `generateStaticParams`).

Next backend requirements: `output: "export"`, `trailingSlash: true`, `serverExternalPackages: ["hybld", "@hybld/next", "jiti"]` in next.config, and a plain `.mjs` hybld config (it is also loaded inside Next build workers, where TypeScript configs cannot be imported). Sites served by a Next server should prefer Next's native ISR; this backend targets static hosting, where Next has no incremental story. See `examples/next-demo` and `examples/astro-demo` for complete working setups.

## Setup

```bash
pnpm install
pnpm run build          # compiles packages/hybld and packages/adapter-wordpress
```

## Try it on the demo site

Terminal 1: start the mock CMS (57 seeded articles, WordPress-shaped REST API):

```bash
cd examples/demo-site
pnpm run cms            # http://localhost:4399, data in mock-cms/articles.json
```

Terminal 2: run builds:

```bash
cd examples/demo-site

# Full build: 57 articles + home + 3 categories + 404 + sitemap
pnpm exec hybld build --all

# Run it again: everything is skipped (content hashes unchanged)
pnpm exec hybld build --all

# Preview any scope without building
pnpm exec hybld build --chunk 1/4 --dry-run

# Serve the static output
npx serve dist
```

Publish a new article, then build only what changed:

```bash
# Add an object to mock-cms/articles.json with a fresh "modified" timestamp,
# or edit any article's content. Then:
pnpm exec hybld build --since last-build
# -> builds the changed article + home + its category page. Nothing else.
```

Other things to try:

```bash
pnpm exec hybld build --slugs demo-article-7        # targeted build
pnpm exec hybld build --ids 12                      # targeted by CMS id
pnpm exec hybld build --limit 10                    # smoke-test build
pnpm exec hybld build --stale --chunk-size 20       # converge pages after app-code changes
pnpm exec hybld preview --slugs upcoming-draft      # render a draft, noindexed, to /_preview/
pnpm exec hybld serve --port 4650 --static --regen  # webhook server + static host + regen-on-miss
pnpm exec hybld sync ../staging --delete --redirects netlify   # apply last build's changes to a dir
pnpm exec hybld assets gc --dry-run                 # find superseded hashed bundles
pnpm exec hybld manifest push --url <presigned-put-url>        # share the manifest via HTTP
pnpm exec hybld status                              # page counts, code-stale count
pnpm exec hybld status --reconcile                  # find articles deleted in the CMS
pnpm exec vite build                                  # plugin mode: plain Vite build prerenders too
```

The serve mode exposes `POST /rebuild` (JSON scope: routes/slugs/ids/since) and
`POST /webhook/wordpress` (standard publish payloads), guarded by `--secret`.
With `--static --regen`, a request for an article page that was never built is
resolved through `pages.article.match` and built on demand (ISR-style).

Changing an article's `slug` in `articles.json` and rebuilding it (`--ids N`) demonstrates move handling: the old page is removed and `.hybld/redirects.json` gains an `old -> new` entry.

After every build, `.hybld/last-build.json` lists exactly which files were created, updated, and deleted, for precise deploy syncs and CDN invalidation.

## Using it in your own project

```bash
pnpm add -D hybld @hybld/adapter-wordpress
```

1. Add the placeholders `<!--app-head-->` and `<!--app-html-->` to your `index.html`.
2. Create `src/entry-server.tsx` default-exporting `({ route, pageType, data }) => ({ html, head })`.
3. Hydrate in your client entry from `window.__HYBLD_DATA__`.
4. Create `hybld.config.ts` (see `examples/demo-site/hybld.config.ts` for a complete example).

## i18n pattern

Multi-locale sites need no special core support: put the locale in your route
functions (`route: (a) => '/' + a.lang + '/articles/' + a.slug + '/'`), filter
or fan out per locale in your adapter/data loaders, and emit hreflang tags from
your `entry-server` head. Each locale's pages are just more routes in the manifest.

## Status

Working v0.3 implementation. Build modes: full / limited / chunked / targeted / incremental (`--since`) / code-stale, with dry-run everywhere. Rendering: built-in prerenderer with per-page head metadata, worker-thread pool, Vite build reuse via source fingerprinting, per-page `data.json` (emitData), image localization from CMS origins. State: SQLite manifest with export/import/merge and HTTP push/pull, per-page dependents and feed entries, asset-graph tracking with `assets gc`. Output: atomic writes, sharded sitemap, RSS feed, slug-change redirects (plus Netlify/nginx emit via `sync`), changed-files report. Operations: build locking with queue coalescing, `serve` webhook/static server with ISR-style regen-on-miss, draft `preview` builds, deploy `sync`. Adapters: generic REST/GraphQL helpers plus WordPress, Strapi, Contentful, and Sanity presets, all with rate-limited access, retry/backoff, per-run memoization, and an opt-in cross-run disk cache (off by default: it trades freshness, use it for bulk full/chunked rebuilds, never for webhook-driven incremental sites). Experimental: Vite plugin mode (`hybld/plugin`). Tests: 44 across 10 Vitest files (`pnpm test` at the root).

Known limitations: image localization rewrites and downloads but does not resize/optimize (needs a native imaging dependency), only one adapter-backed collection page type is supported (`pages.article`), the 1M-article scale benchmark has not been run, and nothing has been tested against a real (non-mock) CMS yet.
