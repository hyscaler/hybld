# @hybld/adapter-strapi

Strapi adapter for [hybld](https://www.npmjs.com/package/hybld), incremental static generation for CMS-backed sites. Handles both Strapi **v4** (`data[].attributes`) and **v5** (flat) response shapes transparently.

## Install

```bash
npm install -D hybld @hybld/adapter-strapi
```

## Usage

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { strapi } from "@hybld/adapter-strapi";

export default defineConfig({
  adapter: strapi({
    baseUrl: "https://cms.example.com",
    contentType: "articles",              // plural API id
    token: process.env.STRAPI_TOKEN,      // Settings -> API Tokens (read access)
    query: { populate: "*" },             // populate relations/media on list requests
  }),

  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      // Articles arrive NORMALIZED AND FLAT regardless of Strapi version:
      // { id, modified (from updatedAt), slug, title, body, cover, ... }
      data: (a) => ({
        title: a.title,
        html: a.body,                     // your rich-text field name
        date: a.publishedAt,
        cover: a.cover?.url ?? null,
      }),
      dependents: () => ["/"],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({
        latest: (await cms.list({ perPage: 10, sort: "publishedAt:desc" })).map((a) => ({
          slug: a.slug, title: a.title,
        })),
      }),
    },
  },
});
```

Extra keys passed to `cms.list({...})` are forwarded as query params, so Strapi's REST filters work directly: `cms.list({ "filters[category][slug][$eq]": "tech" })`, `sort`, `populate`.

## Options

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `baseUrl` | required | Strapi origin; requests go to `<baseUrl>/api/<contentType>`. |
| `contentType` | required | The collection's plural API id. |
| `token` | none | Bearer token for private content. |
| `slugField` | `"slug"` | Which field `--slugs` lookups filter on. |
| `query` | none | Extra params merged into list requests (e.g. `populate`). |

## Capability matrix

| hybld feature | Support | Notes |
| --------------- | --------- | ------- |
| `--since` incremental builds | yes | `filters[updatedAt][$gt]`. |
| Deletion handling in `--since` | no | schedule `hybld status --reconcile --prune` (full ID sweep, removes orphaned pages). |
| Taxonomy enumeration (`cms.listTerms`) | no | enumerate archives from your own endpoint: `enumerate: async () => (await fetch(...)).json()`. |
| Draft previews (`hybld preview`) | no | drafts require the draft/publish API; wire your own preview route if needed. |
| Parallel catalog listing | yes | counts from `meta.pagination.total`. |

## Recipes

**Category archives without listTerms:**

```ts
category: {
  enumerate: async () => {
    const res = await fetch(`${CMS}/api/categories?fields[0]=slug&fields[1]=name`);
    const body = await res.json();
    return body.data.map((c) => ({ id: c.id, slug: c.slug ?? c.attributes?.slug, name: c.name ?? c.attributes?.name }));
  },
  route: (c) => `/category/${c.slug}/`,
  data: async (c, _page, { cms }) => ({
    name: c.name,
    items: await cms.list({ "filters[category][slug][$eq]": c.slug, perPage: 20 }),
  }),
},
```

**Deletion sweep cron** (Strapi cannot report deletions):

```cron
0 3 * * *  npx hybld status --reconcile --prune --json >> /var/log/hybld-reconcile.log
```

**Webhooks.** Strapi's built-in webhooks POST on entry publish/update; point them at hybld's generic endpoint with the entry identity:

```
POST /rebuild   Header: x-hybld-secret: <secret>   Body: {"ids": [123]}
```

All requests share hybld's HTTP layer: bounded concurrency, retry with backoff honoring `Retry-After`, per-run memoization, optional cross-run disk cache.

## Troubleshooting

| Symptom | Fix |
| --------- | ----- |
| Empty lists but content exists | Private content: set `token` (API token with read access). |
| Relations/media missing in `data()` | Add `query: { populate: "*" }` (or a targeted populate). |
| `--slugs` lookup misses | Your slug lives in a different field: set `slugField`. |
| Deleted entries still on the site | Expected between reconcile runs; tighten the `--reconcile --prune` schedule. |

## License

MIT
