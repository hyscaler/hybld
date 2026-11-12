# @hybld/nuxt

Nuxt backend for [hybld](https://www.npmjs.com/package/hybld): incremental static builds for CMS-backed sites. Publish one article and hybld rebuilds that page and its listings through one scoped `nuxi generate`, then merges the result into your deployed site.

Tested with Nuxt 4. Requires Node 22.5 or newer.

## Exports

| Import | Use it in | What it gives you |
| --- | --- | --- |
| `@hybld/nuxt` | `modules` in `nuxt.config.ts` | The Nuxt module; adds the `useHybldData()` composable |
| `@hybld/nuxt/renderer` | `hybld.config.ts` only | `nuxtRenderer(options?)` |
| `@hybld/nuxt/server` | server code only | `hybldData(pageType, ref?)`, `hybldRoutes(pageType)` |

`nuxtRenderer` options: `nuxtOutDir` (default `".output/public"`), `buildCommand` (default `["npx", "nuxi", "generate"]`), `sourceDirs` (inputs that mark pages code-stale when they change), `buildAssetsDir` (when `app.buildAssetsDir` is not `/_nuxt/`).

Module options (under `hybld` in `nuxt.config.ts`): `alwaysPrerender`, extra routes to prerender on every hybld run.

## Project structure

```
my-site/
  hybld.config.ts          # adapter, page types, nuxtRenderer()
  nuxt.config.ts           # modules: ["@hybld/nuxt"]
  app/
    app.vue
    pages/
      index.vue            # useHybldData("home")
      articles/[slug].vue  # useHybldData("article", { slug })
  .output/public/          # nuxi generate output (a staging area)
  site/                    # hybld's cumulative output (what you deploy)
```

## Setup

```bash
npm install -D hybld @hybld/nuxt @hybld/adapter-wordpress
```

**`hybld.config.ts`**

```ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nuxtRenderer } from "@hybld/nuxt/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL! }),
  renderer: nuxtRenderer(),
  outDir: "site",
  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({ title: a.title.rendered, html: a.content.rendered, slug: a.slug }),
      dependents: () => ["/"],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({ latest: (await cms.list({ perPage: 10 })).map((a) => ({ slug: a.slug, title: a.title.rendered })) }),
    },
  },
});
```

**`nuxt.config.ts`**

```ts
export default defineNuxtConfig({
  modules: ["@hybld/nuxt"],
});
```

That one line is the whole Nuxt-side setup. The module:

- registers the `useHybldData()` composable as an auto-import;
- during hybld runs, hands the prerenderer exactly the scoped routes and switches the link crawler off;
- marks every route as prerendered and turns the app manifest off, so client-side navigation reads each page's `_payload.json` instead of running data loaders in the browser. The app manifest lists only the routes of the latest build, which is wrong for a site assembled from many scoped builds.

## Page wiring

```vue
<!-- app/pages/articles/[slug].vue -->
<script setup>
const route = useRoute();
const { data: article } = await useHybldData("article", { slug: route.params.slug });
useHead({ title: article.value.title });
</script>

<template>
  <article>
    <h1>{{ article.title }}</h1>
    <div v-html="article.html" />
  </article>
</template>
```

```vue
<!-- app/pages/index.vue (a singleton page) -->
<script setup>
const { data } = await useHybldData("home");
</script>
```

`useHybldData(pageType, ref?)` wraps `useAsyncData`. While prerendering it reads this run's scope file (or loads through the hybld config on a plain `nuxi generate`). In the browser it never fetches: the prerendered payload already carries the result. In `nuxt dev`, client-side navigations fetch from a dev-only endpoint the module adds.

For enumerated aggregates pass the item's slug or id: `useHybldData("category", { slug: route.params.slug })`.

## How a build works

1. hybld lists what changed and writes those pages, with their data, to `.hybld/scope.ndjson`.
2. It runs `nuxi generate` with `HYBLD_SCOPE` set. The module feeds the scoped routes to the prerenderer; pages read their data from the scope file.
3. Nuxt writes `.output/public/`. hybld copies each scoped page (`index.html` plus its `_payload.json`) and any new files under `_nuxt/` into `site/`. Existing pages are left alone.

Nuxt's static pages (those without route params) and its `200.html` and `404.html` fallbacks are rebuilt on every run and merged as well.

## Production notes for this backend

- Use trailing-slash routes in `route()` (`/articles/x/`); they map to `articles/x/index.html`, which is what Nuxt writes.
- Deploy `site/`, never `.output/public/`. The latter holds only the last run's pages.
- A `nuxi generate` takes several seconds even for one page, so each incremental run costs roughly that. Batch several publishes into one run where you can; `hybld serve` coalesces queued webhook requests for you.
- Large first builds: use `hybld build --all --batch-size 5000`; see [Scaling](https://github.com/MdMotahir/hybld/blob/development/docs/src/content/docs/operate/scaling.md).
- Draft previews (`hybld preview`) are static snapshots on this backend: page scripts are removed, because the Vue router does not know the `/_preview/...` URL.
- If you change `app.buildAssetsDir`, pass the same value as `nuxtRenderer({ buildAssetsDir })`.
- Do not import `@hybld/nuxt/server` from components. It is server-only; `useHybldData` is the way in.

## Migrating an existing Nuxt site

1. Add `@hybld/nuxt` to `modules`.
2. In each page, replace the `useFetch`/`useAsyncData` call that reads the CMS with `useHybldData(...)`.
3. Describe the same page types in `hybld.config.ts`, with `route()` matching your page files exactly.
4. Run `hybld build --limit 20`, check a few pages and click between them, then `hybld build --all`.

## License

MIT
