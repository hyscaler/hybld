# @hybld/astro

Astro render backend for [hybld](https://www.npmjs.com/package/hybld), incremental static builds for CMS-backed Astro sites. Publish one article; hybld runs one scoped `astro build` (~1s in the demo) and merges just that page (and its listings) into your cumulative site.

## Install

```bash
npm install -D hybld @hybld/astro @hybld/adapter-wordpress
```

Requires Node >= 22.5.

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
      data: (a) => ({ title: a.title.rendered, html: a.content.rendered, date: a.date }),
      dependents: (a) => ["/", { type: "category", id: a.category_slug, depth: 2 }],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({ latest: await cms.list({ perPage: 10 }) }),
    },
    category: {
      enumerate: async ({ cms }) => cms.listTerms("category"),
      route: (c) => `/category/${c.slug}/`,
      data: async (c, _page, { cms }) => ({ items: await cms.list({ perPage: 20, category_slug: c.slug }) }),
    },
  },
  sitemap: { enabled: true, baseUrl: "https://www.example.com" },
});
```

## Page wiring

`hybldPaths` in `getStaticPaths` returns only the scoped pages with their data preloaded during hybld runs (zero CMS calls from your pages), and the full catalog on plain `astro build` / `astro dev`. Data flows via props:

```astro
---
// src/pages/articles/[slug].astro
import { hybldPaths } from "@hybld/astro";

export async function getStaticPaths() {
  return hybldPaths("article", (data, job) => ({
    params: { slug: job.slug },
    props: { article: data },       // data() result -> component props
  }));
}
const { article } = Astro.props;
---
<html lang="en">
  <head><title>{article.title}</title></head>
  <body>
    <article><h1 set:html={article.title} /><div set:html={article.html} /></article>
  </body>
</html>
```

Enumerated aggregates use the item identity: `hybldPaths("category", (data, job) => ({ params: { slug: job.item.slug }, props: { category: data } }))`.

Static routes (home) fetch through `hybldData`, which reads the scope first and falls back to your config's loader:

```astro
---
import { hybldData } from "@hybld/astro";
const { latest } = await hybldData("home");
---
```

Layouts, islands (React/Vue/Svelte), and head tags are yours; hybld does not inject markup on this backend. Both `build.format: "directory"` and `"file"` output layouts are handled.

## How a build works

1. hybld resolves the changed pages and their dependents, writes the scope file.
2. Runs `astro build`; your `getStaticPaths` sees only the scoped routes with preloaded data.
3. Merges emitted pages and `_astro/` hashed assets (append-only) into `outDir`; your `public/` files, robots.txt, favicons, and non-HTML endpoints like `rss.xml` are overwrite-copied so they reach the deployed site.
4. Maintains the manifest, sitemap, feed, redirects, and the changed-files deploy report.

## Build and operate

```bash
hybld build --all                  # first full build
hybld build --since last-build     # incremental sweep (cron this)
hybld build --slugs my-article     # webhook-style targeted build
hybld serve --secret "$SECRET"     # webhook server (503 + Retry-After regen on this backend)
```

## Notes and limitations

- Each incremental run costs one `astro build`; it scales with your component graph, not your catalog (only scoped pages render). Webhook coalescing batches editor bursts automatically.
- Add every hybld-related package your config imports to `vite.ssr.external`, including your adapter. Symptom of forgetting: Rollup errors about `fsevents.node`/binary files during `astro build`.
- No `hybld preview` on this backend; wire your own draft route if needed.
- `astro dev` caches the catalog config per process (restart after config changes).

## License

MIT
