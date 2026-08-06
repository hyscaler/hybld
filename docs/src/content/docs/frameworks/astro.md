---
title: "Astro"
description: "Complete implementation guide for the delegated Astro backend: setup, page wiring, data flow, and production notes."
sidebar:
  order: 3
---
hybld computes what changed; `astro build` renders it; hybld merges the result into a cumulative site. Astro's fast builds make it the snappiest delegated backend (~1s incremental runs in the demo). Working reference: `examples/astro-demo`.

## Project structure

```
my-site/
  hybld.config.ts          NEW  content model
  astro.config.mjs              + one vite.ssr.external line
  src/
    layouts/Base.astro          your layouts, unchanged
    pages/
      index.astro               home (static route) + hybldData
      articles/[slug].astro     + hybldPaths/props
      category/[slug].astro
  public/                       copied through on every merge (robots.txt, favicons)
  site/                         hybld's cumulative output (gitignore); Astro's dist/ is staging
  .hybld/                       manifest + state (gitignore)
```

## Setup

```js
// astro.config.mjs
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.example.com",
  vite: {
    // The hybld helper graph runs in Node at build time; keep it out of the SSR bundle.
    ssr: { external: ["hybld", "@hybld/astro", "@hybld/adapter-wordpress", "jiti"] },
  },
});
```

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { astroRenderer } from "@hybld/astro/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL, trackDeletes: true }),
  renderer: astroRenderer(),   // options: { astroOutDir, buildCommand, sourceDirs }
  outDir: "site",              // MUST differ from Astro's "dist" (staging vs cumulative site)
  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({
        title: a.title.rendered,
        html: a.content.rendered,
        excerpt: a.excerpt.rendered,
        date: a.date,
      }),
      dependents: (a) => ["/", { type: "category", id: a.category_slug, depth: 2 }],
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

If your Astro config sets `build.format: "file"` instead of the default `"directory"`, hybld handles both emitted layouts automatically.

## Page wiring

Dynamic routes opt in through `hybldPaths` in `getStaticPaths`. During hybld runs it returns only the scoped pages with their data preloaded (zero CMS calls from your pages); on plain `astro build` or `astro dev` it enumerates the full catalog through your config. Data flows via props:

```astro
---
// src/pages/articles/[slug].astro
import Base from "../../layouts/Base.astro";
import { hybldPaths } from "@hybld/astro";

export async function getStaticPaths() {
  return hybldPaths("article", (data, job) => ({
    params: { slug: job.slug },
    props: { article: data },        // data() result -> component props
  }));
}

const { article } = Astro.props;
const description = article.excerpt?.replace(/<[^>]+>/g, "").trim().slice(0, 160);
---
<Base title={article.title} description={description} canonical={`https://www.example.com${Astro.url.pathname}`}>
  <article>
    <h1 set:html={article.title} />
    <p><time datetime={article.date}>{article.date.slice(0, 10)}</time></p>
    <div set:html={article.html} />
  </article>
</Base>
```

Enumerated aggregates use the `job.item` identity:

```astro
---
// src/pages/category/[slug].astro
import { hybldPaths } from "@hybld/astro";

export async function getStaticPaths() {
  return hybldPaths("category", (data, job) => ({
    params: { slug: job.item.slug },
    props: { category: data },
  }));
}
const { category } = Astro.props;
---
<ul>
  {category.items.map((a) => <li><a href={`/articles/${a.slug}/`}>{a.title}</a></li>)}
</ul>
```

Static routes (home) fetch through `hybldData`, which reads the scope first (its data is in every scope file) and falls back to your config's loader on plain builds:

```astro
---
// src/pages/index.astro
import { hybldData } from "@hybld/astro";
const { latest } = await hybldData("home");
---
```

Head tags, layouts, islands, and everything else Astro are yours to write; hybld does not inject markup on this backend. React/Vue/Svelte islands work exactly as in any Astro site.

## How a build works

1. hybld resolves the scope and dependents, writes `.hybld/scope.ndjson` (route, page type, identity, and prefetched data per line).
2. Runs `astro build`; your `getStaticPaths` sees only the scoped routes and their preloaded data.
3. Merges the emitted pages (both `directory` and `file` build formats) and `_astro/` hashed assets (append-only) into `outDir`, plus overwrite-copy of everything else Astro emits: your `public/` files, robots.txt, favicons, and non-HTML endpoints like `rss.xml`.
4. Runs the shared post-steps: manifest, sitemap, feed, redirects, changed-files report.

Batch padding and always-fresh singletons apply as on Next (Astro tolerates an empty `getStaticPaths`, but padding keeps behavior uniform, and the home page's data rides in every scope file so it stays current).

## Production notes for this backend

- **Each incremental run costs one `astro build`** (~1s for a small app; grows with your component graph, not your catalog, since only scoped pages render). Batch webhook bursts; `hybld serve`'s queue coalescing does this automatically.
- `astroRenderer({ sourceDirs })` defaults cover `src`, `public`, and the Astro config; add extra directories if rendering code lives elsewhere so code changes correctly mark pages stale.
- Add every hybld-related package your config imports to `vite.ssr.external` (including your adapter package). Symptom of forgetting: Rollup errors about `fsevents.node` or binary files during `astro build`.
- No `hybld preview` on this backend (each draft would cost a full Astro build); wire your own draft route if needed.
- serve-mode regen-on-miss responds `503` + `Retry-After` and rebuilds asynchronously.
- `astro dev` caches the full-catalog config per process (restart to pick up hybld config changes); full enumeration is memoized for 60s within a build process.
- If your pages ship no client JS/CSS, `assets gc` reports nothing to collect: there are no hashed assets to manage, which is normal for zero-island Astro sites.

## Migrating an existing Astro site

1. Add the `vite.ssr.external` line and install the packages.
2. Write `hybld.config.ts` describing your content model.
3. In each CMS-driven dynamic route, replace the "fetch everything" `getStaticPaths` body with a `hybldPaths` call; props flow the same as before.
4. `hybld build --limit 20` to verify, then `--all` (or [chunked](/operate/scaling/) for large catalogs).
5. Point deploys at hybld's `outDir` (`site/`) instead of Astro's `dist/`.

Layouts, islands, styling, and file-based static pages are untouched; file-based pages simply merge through as extras on every run.
