# @hybld/sveltekit

SvelteKit backend for [hybld](https://www.npmjs.com/package/hybld): incremental static builds for CMS-backed sites. Publish one article and hybld rebuilds that page and its listings through one scoped `vite build`, then merges the result into your deployed site.

Tested with SvelteKit 3 and `@sveltejs/adapter-static` 4. Requires Node 22.5 or newer.

## Exports

| Import | Use it in | What it gives you |
| --- | --- | --- |
| `@hybld/sveltekit` | `+page.server.js` | `hybldEntries(pageType, map)` for the `entries` export, `hybldData(pageType, ref?)` for `load` |
| `@hybld/sveltekit/renderer` | `hybld.config.ts` only | `sveltekitRenderer(options?)` |

`sveltekitRenderer` options: `kitOutDir` (default `"build"`), `buildCommand` (default `["npx", "vite", "build"]`), `sourceDirs` (inputs that mark pages code-stale when they change), `appDir` (when `kit.appDir` is not `_app`).

## Project structure

```
my-site/
  hybld.config.ts          # adapter, page types, sveltekitRenderer()
  vite.config.js           # sveltekit({ adapter, prerender })
  src/
    app.html
    routes/
      +layout.js           # prerender = true, trailingSlash = "always"
      +page.server.js      # home: hybldData("home")
      +page.svelte
      articles/[slug]/
        +page.server.js    # entries + load
        +page.svelte
  build/                   # adapter-static output (a staging area)
  site/                    # hybld's cumulative output (what you deploy)
```

## Setup

```bash
npm install -D hybld @hybld/sveltekit @hybld/adapter-wordpress @sveltejs/adapter-static
```

**`hybld.config.ts`**

```ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { sveltekitRenderer } from "@hybld/sveltekit/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL! }),
  renderer: sveltekitRenderer(),
  outDir: "site",               // must differ from adapter-static's "build"
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

**`vite.config.js`** (SvelteKit 3 takes its options through the Vite plugin; on SvelteKit 2 the same `adapter` and `prerender` settings go under `kit` in `svelte.config.js`.)

```js
import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ pages: "build", assets: "build" }),
      prerender: {
        // During hybld runs only the scoped pages may be built. Left on, the
        // crawler follows links from the home page into the whole catalog.
        crawl: !process.env.HYBLD_INTERNAL,
      },
    }),
  ],
  // The hybld helpers run in Node at build time; keep them out of the server bundle.
  ssr: { external: ["hybld", "@hybld/sveltekit", "@hybld/adapter-wordpress", "jiti"] },
});
```

**`src/routes/+layout.js`**

```js
export const prerender = true;
export const trailingSlash = "always";   // hybld maps routes to route/index.html
```

## Route wiring

Data access lives in `+page.server.js`, which never reaches the browser.

```js
// src/routes/articles/[slug]/+page.server.js
import { hybldEntries, hybldData } from "@hybld/sveltekit";

// Scoped during hybld runs (only the changed articles); the full catalog on a plain `vite build`.
export const entries = () => hybldEntries("article", (job) => ({ slug: job.slug }));

export const load = async ({ params }) => ({ article: await hybldData("article", { slug: params.slug }) });
```

```js
// src/routes/+page.server.js (a singleton page)
import { hybldData } from "@hybld/sveltekit";

export const load = () => hybldData("home");
```

For enumerated aggregates (category archives), derive params from the enumerated item: `hybldEntries("category", (job) => ({ slug: job.item.slug }))` and `hybldData("category", { slug: params.slug })`.

`hybldEntries` hands your mapper the job (`route`, `slug`, `id`, `item`, `page`). Derive params from those fields, not from `job.data`: on a plain `vite build` the data is not loaded during enumeration, because that would cost one CMS call per page.

## How a build works

1. hybld lists what changed and writes those pages, with their data, to `.hybld/scope.ndjson`.
2. It runs `vite build` with `HYBLD_SCOPE` set. `entries` returns only the scoped params and `load` reads data from the scope file, so no page calls the CMS again.
3. adapter-static writes `build/`. hybld copies each scoped page (`index.html` plus its `__data.json`) and any new hashed files under `_app/immutable` into `site/`. Existing pages are left alone.

Client-side navigation keeps working across builds: each page's `__data.json` travels with it, and hashed chunks are merged append-only, so pages from older builds still find their scripts.

## Production notes for this backend

- `trailingSlash = "always"` is required. Without it pages are emitted as `route.html` and client navigation data lands in a different place.
- Keep `prerender.crawl` off during hybld runs (the `HYBLD_INTERNAL` check above). Forgetting it does not break output, but every run then rebuilds everything the home page links to.
- Deploy `site/`, never `build/`. `build/` holds only the last run's pages.
- Large first builds: use `hybld build --all --batch-size 5000` so each `vite build` stays small; see [Scaling](https://github.com/MdMotahir/hybld/blob/development/docs/src/content/docs/operate/scaling.md).
- Draft previews (`hybld preview`) are static snapshots on this backend: page scripts are removed, because the SvelteKit router does not know the `/_preview/...` URL.
- `kit.version` polling is not needed. If you enable it, a new build makes old pages do a full-page navigation on their next link click, which is harmless.

## Migrating an existing SvelteKit site

1. Switch to `adapter-static` and set `prerender = true` and `trailingSlash = "always"` in the root layout.
2. Move each dynamic route's data loading into `+page.server.js` and replace the CMS call with `hybldData(...)`.
3. Add an `entries` export using `hybldEntries(...)` to every dynamic route.
4. Describe the same page types in `hybld.config.ts`, with `route()` matching your route files exactly.
5. Run `hybld build --limit 20`, check a few pages, then `hybld build --all`.

## License

MIT
