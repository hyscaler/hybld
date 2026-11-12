---
title: "Configuration"
description: "Complete hybld.config reference: adapters, renderers, page types, and every option."
sidebar:
  order: 1
---
`hybld.config.ts` (or `.mts`, `.js`, `.mjs`) at the project root, default-exporting `defineConfig({...})`. Next.js projects must use `.mjs` (see the [Next guide](/frameworks/nextjs/)).

```ts
import { defineConfig } from "hybld";

export default defineConfig({
  adapter,      // required
  renderer,     // default: react-vite
  pages,        // required
  // everything below is optional
  root, outDir, basePath, manifest,
  render, cms, sitemap, feed, redirects,
  emitData, images, preview,
});
```

## Top-level options

| Option | Default | Description |
| -------- | --------- | ------------- |
| `adapter` | required | A `CmsAdapter`: a preset (`wordpress(...)`, `strapi(...)`, `contentful(...)`, `sanity(...)`), a generic helper (`createRestAdapter`, `createGraphqlAdapter`), or any object implementing the interface. |
| `renderer` | react-vite | `reactVite()` from `hybld`, `nextRenderer()` from `@hybld/next/renderer`, `astroRenderer()` from `@hybld/astro/renderer`, or a custom `delegatedRenderer(spec)`. |
| `root` | config file's dir | Project root containing the app. |
| `outDir` | `dist` | Cumulative static output. With delegated backends this MUST differ from the framework's own build dir (use e.g. `site`). |
| `basePath` | `/` | Subpath hosting; defaults to Vite's `base` behavior on the react-vite backend. |
| `manifest` | `.hybld/manifest.db` | SQLite manifest location. |
| `emitData` | `false` | Write a `data.json` next to every page's HTML (client-side navigation without CMS calls). |

## `render` (react-vite backend only)

| Option | Default | Description |
| -------- | --------- | ------------- |
| `entry` | `src/entry-server.tsx` | SSR entry default-exporting `({ route, pageType, data }) => ({ html, head })`. |
| `template` | `index.html` | Vite HTML template; must contain `<!--app-head-->` and `<!--app-html-->`. |
| `workers` | 4 | Render worker threads. Also used as the default engine-side concurrency. Crashed workers are respawned within a bounded budget; a bundle that kills every worker fails the build with the underlying error. |
| `timeout` | 60000 | Per-page render timeout in ms. A hung render fails that page instead of stalling the build. |
| `batchSize` | off | Next.js and Astro only. Splits a large scope into framework builds of at most this many pages and checkpoints the manifest between them, so a crash late in a long first build keeps the batches already merged. `--batch-size <n>` overrides it for one run. |

## `cms`

| Option | Default | Description |
| -------- | --------- | ------------- |
| `concurrency` | 4 | Parallel CMS requests (shared rate-limit layer). |
| `perPage` | 100 | Page size for catalog listing. |
| `requestsPerSecond` | off | Hard throttle. |
| `cache` | `false` | Cross-run disk cache: `true` (300s TTL) or `{ ttlSeconds }`. Modified-since and trash queries always bypass it. Use for bulk full/chunked rebuilds; keep off for webhook-driven sites (it trades freshness). |

## `pages`

### Collection page type

One page per CMS item. The key `article` is a collection by default; other keys opt in with `collection: true`.

```ts
article: {
  collection?: true,            // implicit for the "article" key
  adapter?: CmsAdapter,         // per-collection adapter override
  route: (a) => string,         // item -> URL
  data: (a) => any,             // item -> props; EVERYTHING the page renders must derive from this
  dependents?: (a) => DependentRef[],  // strings (singleton routes) or { type, id, depth }
  match?: (route) => ({ slug } | { id } | null),  // inverse of route(); enables serve regen-on-miss
  id?: (a) => string | number,  // default a.id
  slug?: (a) => string,         // default a.slug
  modifiedAt?: (a) => string,   // default a.modified ?? a.modifiedAt ?? a.updatedAt ?? a.date
}
```

### Aggregate page type

Pages derived from many items.

```ts
// Singleton (home, 404):
home: {
  route: () => "/",
  data: async ({ cms }) => ({ ... }),
}

// Enumerated + paginated (category archives):
category: {
  enumerate: async ({ cms }) => cms.listTerms("category"),
  paginate?: { perPage: 20 },
  pageCount?: (item, ctx) => number,   // default: ceil(item.count / perPage) when item.count exists, else 1
  route: (item, page) => string,
  data: async (item, page, { cms }) => ({ ... }),
}
```

The `cms` helper passed to loaders wraps the adapter with the shared rate limiting and per-run memoization: `cms.list(opts)`, `cms.listTerms(taxonomy)`, `cms.getArticle(ref)`, `cms.count()`, `cms.raw`.

Notes:
- Extra keys passed to `cms.list({ category_slug: "tech" })` are forwarded to the adapter as list filters.
- On delegated backends, singleton aggregates are static framework routes and the framework owns the 404 page; omit a `notFound` page type there.

## `sitemap`

```ts
sitemap: { enabled: true, baseUrl: "https://www.example.com" }
```

Sharded automatically (sitemap index plus files of at most 50,000 URLs), regenerated incrementally from the manifest. Routes ending in `.html` (like `/404.html`) are excluded.

## `feed`

```ts
feed: {
  enabled: true,
  baseUrl?: string,        // default: sitemap.baseUrl
  title?: string,
  description?: string,
  limit?: 20,
  item?: (article) => ({ title, description?, date?, author? }),  // default reads WordPress-shaped fields
}
```

RSS 2.0 at `feed.xml`, maintained from feed entries captured in the manifest at build time (no CMS calls to regenerate).

## `images`

```ts
images: {
  origins: ["https://cms.example.com"],
  dir?: "media",
  optimize?: { maxWidth?: 1600, format?: "webp", quality?: 80 },
}
```

Downloads CMS-hosted images referenced by rendered pages into `outDir/<dir>/` and rewrites their URLs (including framework sidecars like Next RSC payloads). Covers `src`/`href` and `srcset` candidates, and decodes HTML-escaped ampersands so query-string URLs match. Downloads each unique URL once, retrying a transient failure once; a persistent failure leaves the original URL in place.

With `optimize`, PNG, JPEG, WebP and AVIF images are capped to `maxWidth` (never enlarged) and re-encoded before they are written. `format` is `"webp"` (default), `"avif"`, or `"original"` to keep each image's own format; `quality` is 1 to 100. SVG, GIF and ICO files are copied untouched. Optimization needs the optional `sharp` package in your project (`npm install -D sharp`); the build stops with a clear message if it is missing. The settings are part of each file name, so changing them writes new files instead of reusing old ones. Images in a `srcset` are each capped at `maxWidth`, so keep `maxWidth` at or above your largest `w` descriptor.

## `redirects`

```ts
redirects: { file?: ".hybld/redirects.json" }
```

Cumulative, chain-collapsed map of slug changes (`old route -> new route`). Consumed by `hybld sync --redirects netlify|nginx` or your own tooling.

## `preview`

```ts
preview: { pathPrefix?: "/_preview" }
```

Where `hybld preview` writes noindexed draft pages (react-vite backend only).
