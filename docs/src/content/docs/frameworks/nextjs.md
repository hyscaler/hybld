---
title: "Next.js"
description: "Complete implementation guide for the delegated Next backend: App Router and Pages Router wiring, static export requirements, and production notes."
sidebar:
  order: 2
---
hybld's Next backend targets **static export** (`output: "export"`): the deployment mode where Next itself has no incremental story. If your site runs on a Next server, prefer Next's native ISR (`revalidatePath`/`revalidateTag`); hybld adds little there.

How it works: hybld computes which pages changed, writes that scope to a file, runs `next build` (whose dynamic routes read the scope through the helpers below), and merges the emitted pages into a cumulative output directory. Each incremental run costs one Next build (~5s in the demo) regardless of how few pages changed, so batch webhook bursts rather than building per keystroke.

Working references: `examples/next-demo` (App Router), `examples/nextpages-demo` (Pages Router).

## Project structure

```
my-site/
  hybld.config.mjs         NEW  content model (MUST be .mjs, see below)
  next.config.mjs               + 4 required settings
  app/                          (or pages/ for the Pages Router)
    layout.jsx
    page.jsx                    home (static route)
    articles/[slug]/page.jsx    + hybldParams/hybldData calls
    category/[slug]/page.jsx
  site/                         hybld's cumulative output (gitignore); Next's own out/ is staging
  .hybld/                       manifest + state (gitignore)
```

## Hard requirements

```js
// next.config.mjs
const nextConfig = {
  output: "export",        // hybld drives static export only
  trailingSlash: true,     // REQUIRED: emitted paths become route/index.html (+ index.txt RSC payloads)
  images: { unoptimized: true },
  serverExternalPackages: ["hybld", "@hybld/next", "jiti"],  // keep the hybld graph out of Next's bundle
};
export default nextConfig;
```

And the hybld config **must be plain JavaScript** (`hybld.config.mjs`, not `.ts`): the helper fallback loads it inside Next's build workers, where TypeScript configs cannot be imported.

```js
// hybld.config.mjs
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nextRenderer } from "@hybld/next/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL, trackDeletes: true }),
  renderer: nextRenderer(),  // options: { nextOutDir, buildCommand, sourceDirs, keepBuildIds }
  outDir: "site",            // MUST differ from Next's "out" (staging vs cumulative site)
  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({ title: a.title.rendered, html: a.content.rendered, excerpt: a.excerpt.rendered }),
      dependents: () => ["/"],
      match: (route) => {
        const m = route.match(/^\/articles\/([^/]+)\/$/);
        return m ? { slug: m[1] } : null;
      },
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({
        latest: (await cms.list({ perPage: 10 })).map((a) => ({ slug: a.slug, title: a.title.rendered })),
      }),
    },
    category: {
      enumerate: async ({ cms }) => cms.listTerms("category"),
      route: (c) => `/category/${c.slug}/`,
      data: async (c, _page, { cms }) => ({
        name: c.name,
        items: (await cms.list({ perPage: 20, category_slug: c.slug })).map((a) => ({
          slug: a.slug, title: a.title.rendered,
        })),
      }),
    },
  },
  sitemap: { enabled: true, baseUrl: "https://www.example.com" },
});
```

## App Router wiring

Dynamic routes read the scope through the helpers. `hybldParams` returns only the scoped routes during hybld runs, and the full catalog during plain `next build` or `next dev`:

```jsx
// app/articles/[slug]/page.jsx
import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;

export async function generateStaticParams() {
  // Derive params from `job` fields (slug/id/item/page). The data argument is
  // undefined on plain builds by design; pages fetch data via hybldData instead.
  return hybldParams("article", (_data, job) => ({ slug: job.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });
  return {
    title: article.title,
    description: article.excerpt?.replace(/<[^>]+>/g, "").slice(0, 160),
    alternates: { canonical: `https://www.example.com/articles/${slug}/` },
  };
}

export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });  // scope-first: no CMS call during hybld runs
  return (
    <article>
      <h1>{article.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: article.html }} />
    </article>
  );
}
```

Enumerated aggregates work the same way:

```jsx
// app/category/[slug]/page.jsx
export async function generateStaticParams() {
  return hybldParams("category", (_data, job) => ({ slug: job.item.slug }));
}
export default async function CategoryPage({ params }) {
  const { slug } = await params;
  const category = await hybldData("category", { slug });
  return <ul>{category.items.map((a) => <li key={a.slug}><a href={`/articles/${a.slug}/`}>{a.title}</a></li>)}</ul>;
}
```

Static routes (home) just call `hybldData("home")` with no ref: their data is included in every scope file because Next rebuilds static routes on every build. Head/meta tags are Next's job (`generateMetadata`), not hybld's.

## Pages Router wiring

Same helpers plus one line of glue in `getStaticPaths`:

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
      <Head><title>{article.title}</title></Head>
      <article><h1>{article.title}</h1><div dangerouslySetInnerHTML={{ __html: article.html }} /></article>
    </>
  );
}
```

The backend merges the Pages Router's `_next/data/<buildId>/` JSON (what `next/link` navigation fetches) alongside the HTML. Because every `next build` mints a new buildId while visitors sit on HTML with older buildIds baked in, each build's fresh JSON is fanned out to every retained buildId directory, so client-side navigation always serves current props. `nextRenderer({ keepBuildIds: n })` controls how many buildId data dirs are retained (default 3; visitors on HTML older than that degrade to a full-page navigation).

## How a build works

1. hybld resolves the scope and dependents, writes `.hybld/scope.ndjson` (route, page type, identity, and prefetched data per line).
2. Runs `next build`. Your `generateStaticParams`/`getStaticPaths` see only the scoped routes; `hybldData` reads props from the scope with zero CMS calls.
3. Maps emitted `route/index.html` + `route/index.txt` (RSC payload) pairs back to routes; merges them and `_next/static` assets (append-only) into `outDir`; static routes emitted beyond the scope merge as extras, and everything else Next emits (your `public/` files, robots.txt, favicons) is overwrite-copied so it reaches the deployed site.
4. Runs the shared post-steps: manifest, sitemap, feed, redirects, changed-files report.

Details handled for you: every batch carries at least one page per dynamic route type (Next's export refuses an empty `generateStaticParams`; padding comes from the manifest, or one live CMS item on a first-ever build, and a fresh page is promoted back in if freshness-skipping would empty a type), RSC sidecars travel with their pages through merges, deletions, moves, and image-URL rewriting, and the asset graph hash is a source fingerprint (Next's per-build buildId files would otherwise mark everything code-stale after every run).

## Production notes for this backend

- **Each incremental run costs one `next build`.** Persist `.next/cache` across CI runs, and consider `eslint.ignoreDuringBuilds: true` / `typescript.ignoreBuildErrors: true` in next.config for the scoped production builds (run lint/type-check in a separate CI step instead). Batch webhooks: ten article edits in a minute should be one build with ten targets, which `hybld serve`'s queue coalescing does automatically.
- **webpack builds only.** The helpers keep hybld's module graph out of Next's bundle using a `webpackIgnore` dynamic import plus `serverExternalPackages`, both webpack mechanisms. `next build --turbopack` is untested and likely bundles the graph; don't use it with hybld yet.
- `nextRenderer({ sourceDirs })` defaults cover `app`, `pages`, `src`, `components`, `lib`, `styles`, `public`, and the Next config; if your rendering code lives elsewhere, add those paths so code changes correctly mark pages stale.
- No `hybld preview` on this backend (each draft would cost a full Next build); use Next's own draft mode.
- serve-mode regen-on-miss responds `503` + `Retry-After` and rebuilds asynchronously (a framework build must never block an HTTP request).
- `next dev` and plain `next build` fall back to full-catalog enumeration through your config: dev servers cache that config per process (restart to pick up CMS config changes), full enumeration is memoized for 60s within a build process, and plain full builds make one `getArticle` call per page. On a very large catalog, avoid plain `next build` in CI; drive builds through hybld so they are always scoped.

## Migrating an existing static-export Next site

1. Add the four `next.config.mjs` settings and install the packages.
2. Write `hybld.config.mjs` describing your content model (routes, `data()`, dependents).
3. In each dynamic route, replace your "fetch everything" `generateStaticParams`/`getStaticPaths` body with a `hybldParams` call, and the per-page fetch with `hybldData`.
4. `hybld build --limit 20` to verify wiring, then `hybld build --all` (or [chunked](/operate/scaling/) for large catalogs).
5. Point deploys at hybld's `outDir` (`site/`) instead of Next's `out/`.

The change is mechanical: your components and layouts are untouched; only the data-fetching entry points switch to scope-aware helpers.
