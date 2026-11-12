# @hybld/astro

Astro render backend for [hybld](https://www.npmjs.com/package/hybld): incremental static generation for CMS-backed Astro sites. Publish one article in your CMS and hybld runs one scoped `astro build` (~1s in the demo app) that renders only that article and the listing pages it affects, then merges the result into your cumulative site. Your layouts, islands, and styling are untouched; only `getStaticPaths` changes.

```
CMS webhook/cron ──> hybld (what changed? scope = article + its listings)
                        │ writes .hybld/scope.ndjson
                        ▼
                     astro build (renders ONLY the scoped routes)
                        │ emits dist/ (staging)
                        ▼
                     hybld merge ──> site/ (cumulative: HTML, _astro assets,
                                     public files, sitemap, feed, redirects,
                                     changed-files report for your deploy)
```

## Contents

- [Install](#install)
- [Setup: two files](#setup-two-files)
- [Page wiring](#page-wiring)
- [Helper API reference](#helper-api-reference)
- [astroRenderer options](#astrorenderer-options)
- [Recipes](#recipes)
- [How a build works](#how-a-build-works)
- [Running in production](#running-in-production)
- [Troubleshooting](#troubleshooting)
- [Migrating an existing Astro site](#migrating-an-existing-astro-site)

## Install

```bash
npm install -D hybld @hybld/astro @hybld/adapter-wordpress
# adapters: @hybld/adapter-strapi | @hybld/adapter-contentful | @hybld/adapter-sanity
# or generic REST/GraphQL helpers from "hybld/adapters"
```

Requires Node >= 22.5 (hybld uses the built-in `node:sqlite`).

## Setup: two files

### 1. `astro.config.mjs`: one required line

```js
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.example.com",
  vite: {
    // REQUIRED: the hybld helper graph runs in Node at build time; keep it
    // (and your adapter package) out of Astro's SSR bundle.
    ssr: { external: ["hybld", "@hybld/astro", "@hybld/adapter-wordpress", "jiti"] },
  },
});
```

Both `build.format: "directory"` (default) and `"file"` output layouts are handled.

### 2. `hybld.config.ts`: the content model

```ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { astroRenderer } from "@hybld/astro/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL, trackDeletes: true }),
  renderer: astroRenderer(),
  outDir: "site",             // MUST differ from Astro's "dist": dist/ is per-build
                              // staging, site/ is the cumulative deployed site

  pages: {
    // THE COLLECTION: one page per CMS article. data() is the contract:
    // everything the page renders must derive from it (its hash decides
    // whether the page rebuilds).
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({
        title: a.title.rendered,
        html: a.content.rendered,
        excerpt: a.excerpt.rendered,
        date: a.date,
        category: a.category_slug,
      }),
      // The blast radius: this article also affects the home page and the
      // first 2 pages of its category archive.
      dependents: (a) => ["/", { type: "category", id: a.category_slug, depth: 2 }],
      // URL -> identity (inverse of route); enables serve-mode regen-on-miss.
      match: (route) => {
        const m = route.match(/^\/articles\/([^/]+)\/$/);
        return m ? { slug: m[1] } : null;
      },
    },

    // A SINGLETON: derived from many articles.
    home: {
      route: () => "/",
      data: async ({ cms }) => ({
        latest: (await cms.list({ perPage: 10 })).map((a) => ({
          slug: a.slug, title: a.title.rendered, date: a.date,
        })),
      }),
    },

    // ENUMERATED + PAGINATED: one archive per category, 20 per page.
    category: {
      enumerate: async ({ cms }) => cms.listTerms("category"),
      paginate: { perPage: 20 },
      route: (c, page) => (page === 1 ? `/category/${c.slug}/` : `/category/${c.slug}/page/${page}/`),
      data: async (c, page, { cms }) => ({
        name: c.name,
        page,
        items: (await cms.list({ perPage: 20, page, category_slug: c.slug })).map((a) => ({
          slug: a.slug, title: a.title.rendered,
        })),
      }),
    },
  },

  sitemap: { enabled: true, baseUrl: "https://www.example.com" },
  feed: { enabled: true, title: "Example Blog" },
});
```

## Page wiring

### Article pages (the collection)

`hybldPaths` in `getStaticPaths` returns only the scoped pages during hybld runs, **with their data preloaded**, so pages make zero CMS calls. On plain `astro build`/`astro dev` it enumerates the full catalog through your config. Data flows as props:

```astro
---
// src/pages/articles/[slug].astro
import Base from "../../layouts/Base.astro";
import { hybldPaths } from "@hybld/astro";

export async function getStaticPaths() {
  return hybldPaths("article", (data, job) => ({
    params: { slug: job.slug },
    props: { article: data },          // data() result -> component props
  }));
}

const { article } = Astro.props;
const description = article.excerpt?.replace(/<[^>]+>/g, "").trim().slice(0, 160);
---
<Base title={article.title} description={description}
      canonical={`https://www.example.com${Astro.url.pathname}`}>
  <article>
    <h1 set:html={article.title} />
    <p>
      <time datetime={article.date}>{article.date.slice(0, 10)}</time> ·
      <a href={`/category/${article.category}/`}>{article.category}</a>
    </p>
    <div set:html={article.html} />
  </article>
</Base>
```

### Category archives (enumerated aggregate)

```astro
---
// src/pages/category/[slug].astro
import { hybldPaths } from "@hybld/astro";

export async function getStaticPaths() {
  // Enumerated aggregates carry their item on the job:
  return hybldPaths("category", (data, job) => ({
    params: { slug: job.item.slug },
    props: { category: data },
  }));
}
const { category } = Astro.props;
---
<h1>{category.name}</h1>
<ul>{category.items.map((a) => <li><a href={`/articles/${a.slug}/`}>{a.title}</a></li>)}</ul>
```

### Paginated archive pages

```astro
---
// src/pages/category/[slug]/page/[page].astro
import { hybldPaths } from "@hybld/astro";

export async function getStaticPaths() {
  const all = await hybldPaths("category", (data, job) => ({
    params: { slug: job.item.slug, page: String(job.page) },
    props: { category: data },
  }));
  return all.filter((e) => e.params.page !== "1");   // page 1 lives at /category/[slug]/
}
const { category } = Astro.props;
---
<h1>{category.name}, page {category.page}</h1>
```

### The home page (singleton)

```astro
---
// src/pages/index.astro
import { hybldData } from "@hybld/astro";
// No ref needed: singleton data rides in every scope file, because static
// routes rebuild on every framework run and must stay correct.
const { latest } = await hybldData("home");
---
<ul>{latest.map((a) => <li><a href={`/articles/${a.slug}/`}>{a.title}</a></li>)}</ul>
```

Head tags, layouts, and islands (React/Vue/Svelte) are yours; hybld injects no markup on this backend. File-based static pages (about, contact) need no changes; they merge through as extras on every run.

## Helper API reference

### `hybldPaths(pageType, map)`

```ts
hybldPaths<T>(pageType: string, map: (data: any, job: ScopeJob) => T): Promise<T[]>
```

Returns one mapped `{ params, props }` entry per page of `pageType`. During hybld runs: exactly the scoped pages, `data` preloaded from the scope file. On plain builds: the full catalog through your config (memoized 60s per process), with `data` loaded per page.

`ScopeJob` fields:

| Field | Present for | Meaning |
| ------- | ------------- | --------- |
| `route` | all | The page's URL path. |
| `pageType` | all | The `pages.*` key. |
| `slug`, `id` | collections | Article identity. |
| `item` | enumerated aggregates | The enumerated item (e.g. the category term). |
| `page` | paginated aggregates | Page number within the archive. |
| `data` | all | The page's `data()` result. |

### `hybldData(pageType, ref?)`

```ts
hybldData(pageType: string, ref?: { slug?: string; id?: string | number; page?: number }): Promise<any>
```

Scope-first data access: reads the scope file during hybld runs (zero CMS calls), falls back to your config's loaders otherwise. Call shapes:

```js
await hybldData("home");                          // singleton
await hybldData("article", { slug });             // collection by slug
await hybldData("category", { slug, page: 3 });   // paginated aggregate page
```

## astroRenderer options

```ts
astroRenderer({
  astroOutDir: "dist",                    // Astro's build dir (staging), relative to root
  buildCommand: ["npx", "astro", "build"],
  sourceDirs: ["src", "public", "astro.config.mjs", "astro.config.ts", "package.json"],
})
```

`sourceDirs` feeds the **source fingerprint** for code-staleness: when any listed file changes, previously built pages become code-stale (converge with `hybld build --stale`). If rendering code lives outside these paths, add it.

## Recipes

**Deletions.** With an adapter that reports them (`wordpress({ trackDeletes: true })`), `hybld build --since last-build` removes the page, rebuilds its dependents, and updates sitemap/feed. For CMSes that cannot report deletions, schedule `hybld status --reconcile --prune` weekly.

**Slug changes** are moves: old files removed, new page built, `old -> new` recorded in the redirects map (`hybld sync --redirects netlify|nginx` emits host formats).

**CMS-hosted images.** Add `images: { origins: ["https://cms.example.com"] }`: images referenced by rendered pages (src/srcset) are downloaded into `site/media/` and URLs rewritten, so the deployed site does not hotlink the CMS.

**An RSS endpoint of your own** (`src/pages/rss.xml.js`) keeps working: non-HTML outputs are overwrite-copied into `outDir` on every run. hybld's built-in `feed.xml` (config `feed.enabled`) is the zero-code alternative.

**Multiple collections.** Any page type with `collection: true` (optionally with its own adapter) is a collection; target with `hybld build --ids author:42`.

## How a build works

1. hybld resolves the scope: changed pages, their `dependents`, all singletons (their data must be fresh every run), and at least one page per dynamic route type (padding keeps behavior uniform with the Next backend).
2. Writes `.hybld/scope.ndjson` and runs `astro build` with `HYBLD_SCOPE` pointing at it; your `getStaticPaths` sees only the scoped routes with preloaded data.
3. Merges emitted pages (both `directory` and `file` formats) into `outDir`; `_astro/` hashed assets merge append-only; `public/` files, robots.txt, favicons, and non-HTML endpoints overwrite-copy.
4. Records everything in the SQLite manifest, regenerates the sharded sitemap and RSS feed if the page set changed, updates the redirects map, and writes `.hybld/last-build.json` (created/updated/deleted files) for your deploy step.

Each page's `data()` hash is stored; unchanged pages are skipped before Astro runs, and a fully unchanged scope skips the framework build entirely.

## Running in production

```bash
# 1. First full build (chunk across CI jobs for very large catalogs)
hybld build --all

# 2. Webhooks: seconds-fast publishes. Point a CMS webhook at:
hybld serve --host 0.0.0.0 --port 4600 --secret "$WEBHOOK_SECRET"
#    POST /webhook/wordpress {post_id}   or   POST /rebuild {"slugs": ["..."]}
#    Builds queue and coalesce: an editor saving 5 times = one scoped astro build.

# 3. Cron: the safety net (scheduled posts, missed webhooks, deletions)
*/10 * * * *  npx hybld build --since last-build --json >> /var/log/hybld.log
0 3 * * 0     npx hybld status --reconcile --prune

# 4. Deploy only the diff
hybld sync /var/www/site --delete --redirects nginx
#    or read .hybld/last-build.json and push exactly those paths to S3/CDN
```

Exit codes: `0` clean, `2` completed with page failures (listed in the JSON summary), `1` hard error. Failed pages are retried by the next `--since` sweep automatically.

## Troubleshooting

| Symptom | Cause and fix |
| --------- | --------------- |
| Rollup error about `fsevents.node` or binary files during `astro build` | Astro's SSR bundle tried to process the hybld graph. Add every hybld package your config imports (including the adapter) to `vite.ssr.external`. |
| `framework build emitted no file for this route` | The route's `hybldPaths` params do not match your config's `route()` URL shape (check trailing slashes and `build.format`). |
| `astro dev` shows stale config/content | Dev servers cache the catalog config per process; restart. Full enumeration is also memoized for 60s within a build. |
| Everything rebuilds after every deploy | Rendering code lives outside `sourceDirs`; add the missing directories. |
| `assets gc` reports nothing to collect | Normal for zero-island sites: no client JS/CSS means no hashed assets to manage. |
| Draft previews | `hybld preview --slugs my-draft` runs one Astro build and copies only the draft page to `/_preview/...`, noindexed. Scripts and islands are kept. |

## Migrating an existing Astro site

1. Add the `vite.ssr.external` line; install `hybld`, `@hybld/astro`, an adapter.
2. Write `hybld.config.ts` describing routes, `data()`, and `dependents` (your existing fetch code usually moves into `data()` almost verbatim).
3. In each CMS-driven dynamic route, replace the "fetch everything" `getStaticPaths` body with a `hybldPaths` call; props flow exactly as before.
4. Verify with `hybld build --limit 20`, then run `hybld build --all`.
5. Point deploys at hybld's `outDir` (`site/`) instead of Astro's `dist/`.

## Related packages

| Package | Purpose |
| --------- | --------- |
| [hybld](https://www.npmjs.com/package/hybld) | The engine and CLI (manifest, scopes, dependents, serve, sync). |
| [@hybld/next](https://www.npmjs.com/package/@hybld/next) | The same model for Next.js static-export sites. |
| [@hybld/adapter-wordpress](https://www.npmjs.com/package/@hybld/adapter-wordpress), [-strapi](https://www.npmjs.com/package/@hybld/adapter-strapi), [-contentful](https://www.npmjs.com/package/@hybld/adapter-contentful), [-sanity](https://www.npmjs.com/package/@hybld/adapter-sanity) | CMS presets. |

## License

MIT
