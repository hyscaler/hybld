# hybld

**Build one page, not a million.**

hybld is incremental static site generation for CMS-backed sites: publish one article and rebuild only that page and its listings, on React + Vite, Next.js, or Astro.

A SQLite manifest remembers every built page. When your CMS changes, hybld rebuilds only what actually changed: the edited article, the listings and archives that reference it, the sitemap, and the RSS feed. A site with a million articles no longer pays a full-catalog rebuild (and a full round of CMS rate limits) to publish a single post.

- **Incremental by design**: every page's `data()` result is hashed; unchanged pages cost nothing.
- **Dependent pages**: declare that an article affects `/` and its category archive; hybld rebuilds them with it.
- **Deletions and moves**: unpublished articles are removed everywhere; slug changes become redirects.
- **Framework-agnostic**: an owned React + Vite renderer (millisecond warm rebuilds) or delegated Next.js / Astro builds scoped to just the changed pages ([`@hybld/next`](https://www.npmjs.com/package/@hybld/next), [`@hybld/astro`](https://www.npmjs.com/package/@hybld/astro)).
- **Any CMS**: presets for [WordPress](https://www.npmjs.com/package/@hybld/adapter-wordpress), [Strapi](https://www.npmjs.com/package/@hybld/adapter-strapi), [Contentful](https://www.npmjs.com/package/@hybld/adapter-contentful), [Sanity](https://www.npmjs.com/package/@hybld/adapter-sanity), plus generic REST/GraphQL helpers, behind one rate-limited, retrying, memoizing HTTP layer.
- **Operations included**: webhook server with ISR-style regeneration, deploy diffs, chunked CI builds, sharded sitemaps, RSS, asset GC, draft previews.

Requires Node >= 22.5 (uses the built-in `node:sqlite`).

## Install

```bash
# React + Vite project (the default backend, no extra package needed)
npm install -D hybld @hybld/adapter-wordpress

# Next.js project (static export)        # Astro project
npm install -D hybld @hybld/next ...     npm install -D hybld @hybld/astro ...
```

## The config

`hybld.config.ts` at the project root describes your content model. The two ideas that carry the whole system: **`data()` is the unit of change** (its hash decides whether a page rebuilds, so everything the page renders must derive from it), and **`dependents()` is the blast radius** (which listing pages an article affects).

```ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL, trackDeletes: true }),
  outDir: "dist",

  pages: {
    // The collection: one page per CMS article.
    article: {
      route: (a) => `/articles/${a.slug}/`,               // your URL scheme, not the CMS's
      data: (a) => ({ title: a.title.rendered, html: a.content.rendered, date: a.date }),
      dependents: (a) => ["/", { type: "category", id: a.category_slug, depth: 2 }],
      match: (route) => {                                  // URL -> identity (serve-mode regen)
        const m = route.match(/^\/articles\/([^/]+)\/$/);
        return m ? { slug: m[1] } : null;
      },
    },
    // A singleton aggregate.
    home: {
      route: () => "/",
      data: async ({ cms }) => ({ latest: await cms.list({ perPage: 10 }) }),
    },
    // An enumerated, paginated aggregate.
    category: {
      enumerate: async ({ cms }) => cms.listTerms("category"),
      paginate: { perPage: 20 },
      route: (c, page) => (page === 1 ? `/category/${c.slug}/` : `/category/${c.slug}/page/${page}/`),
      data: async (c, page, { cms }) => ({ items: await cms.list({ perPage: 20, page, category_slug: c.slug }) }),
    },
  },

  sitemap: { enabled: true, baseUrl: "https://www.example.com" },
  feed: { enabled: true, title: "Example Blog" },
});
```

## React + Vite wiring (the default backend)

Four files. 1) `index.html` gets two placeholders:

```html
<head>
  <!--app-head-->
</head>
<body>
  <div id="root"><!--app-html--></div>
  <script type="module" src="/src/entry-client.tsx"></script>
</body>
```

2) A pageType map, 3) a server entry, 4) hydration:

```tsx
// src/pages.ts
export const PAGES = { article: ArticlePage, home: HomePage, category: CategoryPage };

// src/entry-server.tsx: hybld calls this once per page in a worker pool
import { renderToString } from "react-dom/server";
import { PAGES } from "./pages";
export default function render({ route, pageType, data }) {
  const html = renderToString(<PAGES[pageType] {...data} />);
  const head = `<title>${escapeHtml(data.title)}</title>
    <link rel="canonical" href="https://www.example.com${route}">`;
  return { html, head };
}

// src/entry-client.tsx: hydrate from the injected payload
import { hydrateRoot } from "react-dom/client";
import { PAGES } from "./pages";
const p = window.__HYBLD_DATA__;
if (p) hydrateRoot(document.getElementById("root"), <PAGES[p.pageType] {...p.data} />);
```

For Next.js and Astro wiring, see the [@hybld/next](https://www.npmjs.com/package/@hybld/next) and [@hybld/astro](https://www.npmjs.com/package/@hybld/astro) package pages.

## Build

```bash
hybld build --all                  # first full build (then re-run it: everything skips)
hybld build --since last-build     # everything the CMS modified since the last sweep
hybld build --slugs my-article     # exactly one article (what a webhook does)
hybld build --ids 123
hybld build --chunk 3/10           # deterministic slice (parallel CI full builds)
hybld build --stale --chunk-size 50000   # converge after an app-code deploy
```

Every build also maintains the sharded sitemap, the RSS feed, the redirects map, and writes a changed-files report to `.hybld/last-build.json` so deploys ship only what changed. Exit codes: 0 clean, 2 completed with page failures, 1 hard error. `--json` prints the machine-readable summary.

## Production wiring

```bash
# Webhooks: seconds-fast publishes. CMS POSTs to /webhook/wordpress or /rebuild.
hybld serve --host 0.0.0.0 --port 4600 --secret "$WEBHOOK_SECRET" --static

# Cron: the safety net for scheduled posts, missed webhooks, deletions.
*/10 * * * *  npx hybld build --since last-build --json >> /var/log/hybld.log
0 3 * * 0     npx hybld status --reconcile --prune

# Deploy the diff:
hybld sync /var/www/site --delete --redirects nginx
# or read .hybld/last-build.json and push exactly those paths to S3/CDN
```

Builds queue and coalesce (an editor saving five times in a minute triggers one rebuild). The serve endpoints are secret-protected, loopback-bound by default, and regen-on-miss is rate-guarded.

## Programmatic API

```ts
import { createBuilder } from "hybld";

const builder = await createBuilder({ wait: true });   // one warm builder per process
const summary = await builder.build({ ids: [postId] });
// { built, skipped, failed: [{route, error}], deleted, moved, durationMs, ... }
await builder.close();
```

Per-page failures land in `summary.failed` (the batch continues; the incremental cursor holds back so the next sweep retries). Run-level failures reject.

## CLI reference

| Command | Purpose |
| --------- | --------- |
| `hybld build <scope>` | Build a scope: `--all`, `--limit N`, `--chunk i/n`, `--chunk-size N`, `--routes/--slugs/--ids`, `--since`, `--stale`. Modifiers: `--force --clean --dry-run --no-dependents --fail-fast --json --wait`. |
| `hybld serve` | Webhook server + optional static hosting + regen-on-miss. |
| `hybld status [--reconcile [--prune]]` | Totals, code-stale count; reconcile sweeps for CMS-side deletions. |
| `hybld preview --slugs ...` | Render drafts to a noindexed path (React + Vite backend). |
| `hybld sync <dir>` | Apply the changed-files report to a target directory. |
| `hybld assets gc` | Delete hashed assets no page references. |
| `hybld manifest export/import/merge/push/pull` | Manifest transport for CI. |

## At scale

Designed and benchmarked for very large catalogs: ~6,000 pages/s engine throughput, sub-second incrementals at 200k pages, chunked first builds across CI jobs, and request budgeting that lists a 1M-article catalog in ~10k CMS calls. Key rule: derive `data()` from the list payload so the build never fetches articles one by one.

## License

MIT
