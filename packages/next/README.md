# @hybld/next

Next.js render backend for [hybld](https://www.npmjs.com/package/hybld): incremental static generation for CMS-backed Next sites using **static export** (`output: "export"`). Publish one article in your CMS and hybld runs one scoped `next build` that renders only that article and the listing pages it affects, then merges the result into your cumulative site. A million-page site updates in the time of one small Next build instead of a full-catalog export.

Supports the **App Router and the Pages Router**. If your site runs on a Next server, prefer Next's native ISR (`revalidatePath`/`revalidateTag`); hybld targets static hosting, where Next itself has no incremental story.

```
CMS webhook/cron ──> hybld (what changed? scope = article + its listings)
                        │ writes .hybld/scope.ndjson
                        ▼
                     next build (renders ONLY the scoped routes)
                        │ emits out/ (staging)
                        ▼
                     hybld merge ──> site/ (cumulative: HTML, RSC payloads,
                                     _next assets, sitemap, feed, redirects,
                                     changed-files report for your deploy)
```

## Contents

- [Install](#install)
- [Setup: three files](#setup-three-files)
- [App Router wiring](#app-router-wiring)
- [Pages Router wiring](#pages-router-wiring)
- [Helper API reference](#helper-api-reference)
- [nextRenderer options](#nextrenderer-options)
- [Recipes](#recipes)
- [How a build works](#how-a-build-works)
- [Running in production](#running-in-production)
- [Troubleshooting](#troubleshooting)
- [Migrating an existing static-export site](#migrating-an-existing-static-export-site)

## Install

```bash
npm install -D hybld @hybld/next @hybld/adapter-wordpress
# adapters: @hybld/adapter-strapi | @hybld/adapter-contentful | @hybld/adapter-sanity
# or generic REST/GraphQL helpers from "hybld/adapters"
```

Requires Node >= 22.5 (hybld uses the built-in `node:sqlite`).

## Setup: three files

### 1. `next.config.mjs`: four required settings

```js
const nextConfig = {
  output: "export",        // hybld drives static export only
  trailingSlash: true,     // REQUIRED: emitted paths become route/index.html (+ RSC payloads)
  images: { unoptimized: true },
  serverExternalPackages: ["hybld", "@hybld/next", "jiti"],  // keep hybld out of Next's bundle
};
export default nextConfig;
```

Why each one: `output: "export"` is the mode this backend drives; `trailingSlash` makes Next emit `route/index.html` files hybld can address per page; `images.unoptimized` because static export has no image server; `serverExternalPackages` prevents webpack from bundling hybld's Node-only module graph into build workers.

### 2. `hybld.config.mjs`: the content model

Must be **plain JavaScript** (`.mjs`, not `.ts`): the helpers load it inside Next's build workers, where TypeScript configs cannot be imported.

```js
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nextRenderer } from "@hybld/next/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL, trackDeletes: true }),
  renderer: nextRenderer(),
  outDir: "site",             // MUST differ from Next's "out": out/ is per-build staging,
                              // site/ is the cumulative deployed site

  pages: {
    // THE COLLECTION: one page per CMS article. data() is the contract:
    // everything the page renders must derive from it, because its hash
    // decides whether the page rebuilds.
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({
        title: a.title.rendered,
        html: a.content.rendered,
        excerpt: a.excerpt.rendered,
        date: a.date,
        category: a.category_slug,
      }),
      // The blast radius: publishing/editing/deleting this article also
      // rebuilds the home page and the first 2 pages of its category archive.
      dependents: (a) => ["/", { type: "category", id: a.category_slug, depth: 2 }],
      // URL -> identity (inverse of route); enables serve-mode regen-on-miss.
      match: (route) => {
        const m = route.match(/^\/articles\/([^/]+)\/$/);
        return m ? { slug: m[1] } : null;
      },
    },

    // A SINGLETON: derived from many articles, rebuilt when declared as a dependent.
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

### 3. Your routes call the helpers

That's the rest of this document.

## App Router wiring

The single change to your pages: `generateStaticParams` asks hybld which routes to build, and data comes from `hybldData` (which reads the scope file during hybld runs, so pages make **zero CMS calls**).

### Article pages (the collection)

```jsx
// app/articles/[slug]/page.jsx
import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;   // static export: every path is known at build time

export async function generateStaticParams() {
  // Scoped during hybld runs (only the changed articles), full catalog on
  // plain `next build`/`next dev`. Derive params from job fields; the first
  // argument (data) is undefined on plain builds by design.
  return hybldParams("article", (_data, job) => ({ slug: job.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const a = await hybldData("article", { slug });
  return {
    title: a.title,
    description: a.excerpt?.replace(/<[^>]+>/g, "").trim().slice(0, 160),
    alternates: { canonical: `https://www.example.com/articles/${slug}/` },
    openGraph: { title: a.title, type: "article" },
  };
}

export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const a = await hybldData("article", { slug });
  return (
    <article>
      <h1>{a.title}</h1>
      <p><time dateTime={a.date}>{a.date.slice(0, 10)}</time> · <a href={`/category/${a.category}/`}>{a.category}</a></p>
      <div dangerouslySetInnerHTML={{ __html: a.html }} />
    </article>
  );
}
```

### Category archives (enumerated aggregate)

```jsx
// app/category/[slug]/page.jsx
import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;

export async function generateStaticParams() {
  // Enumerated aggregates carry their item on the job:
  return hybldParams("category", (_data, job) => ({ slug: job.item.slug }));
}

export default async function CategoryPage({ params }) {
  const { slug } = await params;
  const category = await hybldData("category", { slug });
  return (
    <>
      <h1>{category.name}</h1>
      <ul>{category.items.map((a) => (
        <li key={a.slug}><a href={`/articles/${a.slug}/`}>{a.title}</a></li>
      ))}</ul>
    </>
  );
}
```

### Paginated archive pages

```jsx
// app/category/[slug]/page/[page]/page.jsx
export async function generateStaticParams() {
  // One scope job per archive page; job.page carries the page number.
  return hybldParams("category", (_data, job) => ({
    slug: job.item.slug,
    page: String(job.page),
  })).then((params) => params.filter((p) => p.page !== "1"));  // page 1 lives at /category/[slug]/
}

export default async function CategoryPageN({ params }) {
  const { slug, page } = await params;
  const category = await hybldData("category", { slug, page: Number(page) });
  return <h1>{category.name}, page {category.page}</h1>;
}
```

### The home page (singleton)

```jsx
// app/page.jsx
import { hybldData } from "@hybld/next";

export default async function Home() {
  // No ref needed: singleton data rides in every scope file, because Next
  // rebuilds static routes on every build and the page must stay correct.
  const { latest } = await hybldData("home");
  return <ul>{latest.map((a) => <li key={a.slug}><a href={`/articles/${a.slug}/`}>{a.title}</a></li>)}</ul>;
}
```

Head/meta tags are Next's job (`generateMetadata`); hybld injects nothing on this backend.

## Pages Router wiring

Identical model, `getStaticPaths`/`getStaticProps` shape:

```jsx
// pages/articles/[slug].jsx
import Head from "next/head";
import { hybldParams, hybldData } from "@hybld/next";

export async function getStaticPaths() {
  const params = await hybldParams("article", (_data, job) => ({ slug: job.slug }));
  return { paths: params.map((p) => ({ params: p })), fallback: false };
}

export async function getStaticProps({ params }) {
  const article = await hybldData("article", { slug: params.slug });
  return { props: { article } };
}

export default function ArticlePage({ article }) {
  return (
    <>
      <Head>
        <title>{article.title}</title>
        <link rel="canonical" href={`https://www.example.com/articles/${article.slug}/`} />
      </Head>
      <article><h1>{article.title}</h1><div dangerouslySetInnerHTML={{ __html: article.html }} /></article>
    </>
  );
}
```

**Client-side navigation stays current.** The Pages Router fetches `/_next/data/<buildId>/route.json` on `next/link` navigations, and every `next build` mints a new buildId while visitors sit on HTML with older buildIds baked in. The backend handles this: each build's fresh JSON is fanned out to every retained buildId directory, and deleted pages have their JSON removed across all of them. `nextRenderer({ keepBuildIds: n })` controls retention (default 3; visitors on HTML older than that gracefully degrade to full-page navigation).

## Helper API reference

Both helpers are safe to call in any server context (`generateStaticParams`, `generateMetadata`, server components, `getStaticPaths`, `getStaticProps`). They load hybld through a webpack-ignored dynamic import, so Next's bundler never processes the graph.

### `hybldParams(pageType, map)`

```ts
hybldParams<T>(pageType: string, map: (data: any, job: ScopeJob) => T): Promise<T[]>
```

Returns one mapped entry per page of `pageType`. During hybld runs: exactly the scoped pages. On plain `next build`/`next dev`: the full catalog, enumerated through your config (memoized for 60s per process; `data` is `undefined` on this path so enumeration never pays per-article CMS calls, so always derive params from `job`).

`ScopeJob` fields:

| Field | Present for | Meaning |
| ------- | ------------- | --------- |
| `route` | all | The page's URL path. |
| `pageType` | all | The `pages.*` key. |
| `slug`, `id` | collections | Article identity. |
| `item` | enumerated aggregates | The enumerated item (e.g. the category term). |
| `page` | paginated aggregates | Page number within the archive. |
| `data` | hybld runs only | The page's `data()` result (undefined on plain builds). |

### `hybldData(pageType, ref?)`

```ts
hybldData(pageType: string, ref?: { slug?: string; id?: string | number; page?: number }): Promise<any>
```

Returns the page's `data()` result. Scope-first: during hybld runs it is read from the scope file (zero CMS calls). Fallback (plain builds, dev, or a ref outside the scope): loaded through your config, `getArticle` for collections, `enumerate` + `data(item, page)` for aggregates. Call shapes:

```js
await hybldData("home");                          // singleton
await hybldData("article", { slug });             // collection by slug
await hybldData("article", { id: 123 });          // collection by id
await hybldData("category", { slug });            // enumerated aggregate (page 1)
await hybldData("category", { slug, page: 3 });   // paginated aggregate page
```

## nextRenderer options

```js
nextRenderer({
  nextOutDir: "out",                   // Next's export dir (staging), relative to root
  buildCommand: ["npx", "next", "build"],
  sourceDirs: [                        // fingerprint inputs for code-staleness
    "app", "pages", "src", "components", "lib", "styles", "public",
    "next.config.mjs", "next.config.ts", "next.config.js", "package.json",
  ],
  keepBuildIds: 3,                     // Pages Router _next/data retention (see above)
})
```

`sourceDirs` feeds the **source fingerprint**: when any listed file changes, previously built pages become code-stale (converge with `hybld build --stale`). If rendering code lives outside these paths, add it, or code changes will not mark pages stale. Output is intentionally NOT hashed: Next emits differently-named buildId files every run, which would mark everything stale after every build.

## Recipes

**Deletions.** With an adapter that reports them (`wordpress({ trackDeletes: true })`), `hybld build --since last-build` removes the page's HTML and RSC payload, its `_next/data` JSON across retained buildIds, rebuilds its dependents, and updates sitemap/feed. For CMSes that cannot report deletions, schedule `hybld status --reconcile --prune` weekly.

**Slug changes** are moves, not delete+create: old files removed, new page built, `old -> new` recorded in the redirects map (`hybld sync --redirects netlify|nginx` emits host formats).

**CMS-hosted images.** Add `images: { origins: ["https://cms.example.com"] }` to the config: images referenced by rendered pages (src/srcset) are downloaded into `site/media/` and their URLs rewritten, in the HTML *and* the RSC payloads, so the deployed site does not hotlink the CMS.

**Multiple collections.** Any page type with `collection: true` (and optionally its own adapter) is a collection; target with `hybld build --ids author:42`:

```js
author: {
  collection: true,
  adapter: wordpress({ baseUrl: CMS_URL, postType: "users" }),
  route: (u) => `/authors/${u.slug}/`,
  data: (u) => ({ name: u.name }),
},
```

## How a build works

1. hybld resolves the scope: the targeted/changed pages, plus their `dependents`, plus always the singletons (their data must be fresh in every build), plus at least one page per dynamic route type (Next's export refuses an empty `generateStaticParams`; padding comes from the manifest, or one live item on a first-ever build).
2. Writes `.hybld/scope.ndjson` (route, page type, identity, and prefetched `data()` per line) and runs `next build` with `HYBLD_SCOPE` pointing at it.
3. Maps emitted `route/index.html` + `route/index.txt` (RSC payload) pairs back to routes; merges them into `outDir`; `_next/static` assets merge append-only; `public/` files, robots.txt, favicons overwrite-copy; static routes emitted beyond the scope merge as extras.
4. Fans out `_next/data` JSON (Pages Router), records everything in the SQLite manifest, regenerates the sharded sitemap and RSS feed if the page set changed, updates the redirects map, and writes `.hybld/last-build.json` (created/updated/deleted files) for your deploy step.

Each page's `data()` hash is stored; pages whose data did not change are skipped before Next ever runs, and a scope that turns out fully unchanged skips the framework build entirely.

## Running in production

```bash
# 1. First full build (chunk it across CI jobs for very large catalogs)
hybld build --all

# 2. Webhooks: seconds-fast publishes. Point a CMS webhook at:
hybld serve --host 0.0.0.0 --port 4600 --secret "$WEBHOOK_SECRET"
#    POST /webhook/wordpress {post_id}   or   POST /rebuild {"slugs": ["..."]}
#    Builds queue and coalesce: an editor saving 5 times = one scoped next build.

# 3. Cron: the safety net (scheduled posts, missed webhooks, deletions)
*/10 * * * *  npx hybld build --since last-build --json >> /var/log/hybld.log
0 3 * * 0     npx hybld status --reconcile --prune

# 4. Deploy only the diff
hybld sync /var/www/site --delete --redirects nginx
#    or read .hybld/last-build.json and push exactly those paths to S3/CDN
```

CI notes: persist `.next/cache` between runs; consider `eslint.ignoreDuringBuilds: true` and `typescript.ignoreBuildErrors: true` in next.config for the scoped production builds (run lint/type-check as a separate CI step); exit codes are `0` clean, `2` completed with page failures (listed in the JSON summary), `1` hard error.

## Troubleshooting

| Symptom | Cause and fix |
| --------- | --------------- |
| `Page "..." is missing "generateStaticParams()"` | A dynamic route does not call `hybldParams`. Every dynamic route in the app must. |
| `Cannot find module 'node:path'` inside `next build` | Next bundled the hybld graph. Check all three: `serverExternalPackages` in next.config, helpers imported from `@hybld/next` (not deep paths), and a `.mjs` hybld config. |
| `hybld config not found` inside build workers | The config is `.ts`. It must be `.mjs` for Next projects. |
| `framework build emitted no file for this route` | Usually `trailingSlash: true` missing, or the route's `hybldParams` mapping produces params that do not match your `route()` URL. |
| Stale content on client-side navigation | You are on a hybld version without `_next/data` fan-out, or `keepBuildIds` is too low for your deploy cadence. |
| Everything rebuilds after every deploy | Rendering code lives outside `sourceDirs`; add the missing directories. |
| Slow incremental builds | Each run pays one `next build`; persist `.next/cache`, skip lint/type-check in the build, batch webhooks. |

## Migrating an existing static-export site

1. Add the four `next.config.mjs` settings; install `hybld`, `@hybld/next`, an adapter.
2. Write `hybld.config.mjs` describing routes, `data()`, and `dependents` (your existing fetch code usually moves into `data()` almost verbatim).
3. In each dynamic route, replace the "fetch everything" `generateStaticParams`/`getStaticPaths` body with a `hybldParams` call and the per-page fetch with `hybldData`. Components and layouts are untouched.
4. Verify with `hybld build --limit 20`, then run `hybld build --all`.
5. Point deploys at hybld's `outDir` (`site/`) instead of Next's `out/`.

## Related packages

| Package | Purpose |
| --------- | --------- |
| [hybld](https://www.npmjs.com/package/hybld) | The engine and CLI (manifest, scopes, dependents, serve, sync). |
| [@hybld/astro](https://www.npmjs.com/package/@hybld/astro) | The same model for Astro sites. |
| [@hybld/adapter-wordpress](https://www.npmjs.com/package/@hybld/adapter-wordpress), [-strapi](https://www.npmjs.com/package/@hybld/adapter-strapi), [-contentful](https://www.npmjs.com/package/@hybld/adapter-contentful), [-sanity](https://www.npmjs.com/package/@hybld/adapter-sanity) | CMS presets. |

## License

MIT
