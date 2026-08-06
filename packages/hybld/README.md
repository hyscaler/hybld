# hybld

**Build one page, not a million.**

hybld is incremental static site generation for CMS-backed sites: publish one article and rebuild only that page and its listings, on React + Vite, Next.js, or Astro.

A SQLite manifest remembers every built page. When your CMS changes, hybld rebuilds only what actually changed: the edited article, the listings and archives that reference it, the sitemap, and the RSS feed. A site with a million articles no longer pays a full-catalog rebuild (and a full round of CMS rate limits) to publish a single post.

## Install

```bash
# React + Vite project (the default backend, no extra package needed)
npm install -D hybld @hybld/adapter-wordpress

# Next.js project (static export)
npm install -D hybld @hybld/next @hybld/adapter-wordpress

# Astro project
npm install -D hybld @hybld/astro @hybld/adapter-wordpress
```

Adapters: `@hybld/adapter-wordpress`, `@hybld/adapter-strapi`, `@hybld/adapter-contentful`, `@hybld/adapter-sanity`, or the generic REST/GraphQL helpers from `hybld/adapters`.

Requires Node >= 22.5 (uses the built-in `node:sqlite`).

## The minimum config

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";

export default defineConfig({
  adapter: wordpress({ baseUrl: "https://cms.example.com" }),
  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({ title: a.title.rendered, html: a.content.rendered }),
      dependents: (a) => ["/"],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({ latest: await cms.list({ perPage: 10 }) }),
    },
  },
});
```

## Build

```bash
hybld build --all                 # first full build
hybld build --all                 # nothing changed: everything skips, near-instantly
hybld build --since last-build    # everything the CMS modified since the last sweep
hybld build --slugs my-article    # exactly one article (e.g. from a webhook)
hybld build --chunk 3/10          # slice 3 of 10 (parallel CI full builds)
```

Each build also maintains the sharded sitemap, the RSS feed, the redirects map (slug changes become redirects), and writes a changed-files report to `.hybld/last-build.json` so your deploy ships only what changed.

## Highlights

- **Incremental by design**: content hashing plus a manifest; unchanged pages cost nothing.
- **Dependent pages**: declare that an article affects `/` and its category archive; hybld rebuilds them with it (bounded pagination depth for archives).
- **Deletions and moves**: unpublished articles are removed everywhere; slug changes produce redirects.
- **Framework-agnostic**: an owned React + Vite renderer (millisecond warm rebuilds) or delegated Next.js / Astro builds scoped to just the changed pages.
- **Any CMS**: presets for WordPress, Strapi, Contentful, Sanity; generic REST and GraphQL helpers; one rate-limited, retrying, memoizing HTTP layer.
- **Operations included**: `hybld serve` (webhooks + ISR-style regeneration), `hybld sync` deploy diffs, chunked CI builds, asset GC, draft previews.

## Documentation

Full guides (getting started, framework wiring, configuration, CLI, deployment):
https://github.com/MdMotahir/hybld

## License

MIT
