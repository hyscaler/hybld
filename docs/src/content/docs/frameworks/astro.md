---
title: "Astro"
description: "The delegated Astro backend: setup, page helpers, and limitations."
sidebar:
  order: 3
---
hybld computes what changed; `astro build` renders it; hybld merges the result. Astro's fast builds make it the snappiest delegated backend (~1s incremental runs in the demo). Working reference: `examples/astro-demo`.

## Setup

```js
// astro.config.mjs
import { defineConfig } from "astro/config";

export default defineConfig({
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
  adapter: wordpress({ baseUrl: CMS_URL, trackDeletes: true }),
  renderer: astroRenderer(),   // options: { astroOutDir, buildCommand, sourceDirs }
  outDir: "site",              // must differ from Astro's "dist"
  pages: { ... },
});
```

## Page wiring

Dynamic routes opt in through `hybldPaths` in `getStaticPaths` (scoped during hybld runs, full catalog otherwise). Data can flow via props:

```astro
---
// src/pages/articles/[slug].astro
import { hybldPaths } from "@hybld/astro";

export async function getStaticPaths() {
  return hybldPaths("article", (data, job) => ({
    params: { slug: job.slug },
    props: { article: data },
  }));
}

const { article } = Astro.props;
---
<html lang="en">
  <head>
    <title>{article.title} | My Site</title>
  </head>
  <body>
    <article><h1>{article.title}</h1><div set:html={article.html} /></article>
  </body>
</html>
```

Enumerated aggregates: `hybldPaths("category", (data, job) => ({ params: { slug: job.item.slug }, props: { category: data } }))`.

Static routes (home) fetch through `hybldData`, which reads the scope first (its data is in every scope file) and falls back to your config's loader:

```astro
---
import { hybldData } from "@hybld/astro";
const { latest } = await hybldData("home");
---
```

Head tags are yours to write in the `.astro` templates; hybld does not inject them on this backend.

## How a build works

Identical to the Next flow: scope file, one `astro build` per batch, merge of emitted pages (both `directory` and `file` build formats are handled) and `_astro/` assets, plus overwrite-copy of everything else Astro emits (your `public/` files, robots.txt, favicons, `rss.xml` endpoints), then the shared post-steps (manifest, sitemap, feed, redirects, changed-files report). Batch padding and always-fresh singletons apply as on Next; empty `getStaticPaths` is tolerated by Astro but padding keeps behavior uniform.

## Limitations on this backend

- No `hybld preview` (use your own draft pattern).
- serve-mode regen-on-miss responds `503` + `Retry-After` and rebuilds asynchronously.
- `astro dev` caches the full-catalog config per process; restart to pick up hybld config changes.
- If your pages ship no client JS/CSS, `assets gc` reports nothing to collect (there are no hashed assets to manage).
