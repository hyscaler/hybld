# @hybld/adapter-sanity

Sanity adapter for [hybld](https://www.npmjs.com/package/hybld), incremental static generation for CMS-backed sites, GROQ-based against the Sanity HTTP API.

## Install

```bash
npm install -D hybld @hybld/adapter-sanity
```

## Usage

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { sanity } from "@hybld/adapter-sanity";

export default defineConfig({
  adapter: sanity({
    projectId: process.env.SANITY_PROJECT,
    dataset: "production",
    type: "post",                          // GROQ _type filter
    apiVersion: "2024-01-01",
    useCdn: true,
  }),

  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      // Documents arrive NORMALIZED: { id (from _id), modified (from _updatedAt),
      // slug (from slug.current), ...doc } so fields read directly:
      data: (a) => ({
        title: a.title,
        body: a.body,                      // Portable Text: render with your PT renderer in the page
        date: a.publishedAt,
      }),
      dependents: () => ["/"],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({
        latest: (await cms.list({ perPage: 10 })).map((a) => ({ slug: a.slug, title: a.title })),
      }),
    },
  },
});
```

## Options

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `projectId`, `dataset` | required | Sanity project and dataset. |
| `type` | required | The document `_type` this collection queries. |
| `apiVersion` | recent | API version date. |
| `token` | none | Auth for private datasets; combine with `useCdn: false` to reach drafts. |
| `useCdn` | `true` | Cached CDN reads; disable for freshest data / drafts. |
| `normalize` | built-in | Override the document -> article normalization if your schema needs it. |

## Capability matrix

| hybld feature | Support | Notes |
| --------------- | --------- | ------- |
| `--since` incremental builds | yes | `_updatedAt > $since` (bound GROQ parameter). |
| Deletion handling in `--since` | no | schedule `hybld status --reconcile --prune`. |
| Taxonomy enumeration (`cms.listTerms`) | no | enumerate with your own GROQ (below). |
| Draft previews (`hybld preview`) | no | `token` + `useCdn: false` reads drafts; wire your own preview flow. |
| Query safety | yes | all dynamic values are bound GROQ parameters, never string-concatenated. |

## Recipes

**Category archives with your own GROQ:**

```ts
category: {
  enumerate: async () => {
    const q = encodeURIComponent('*[_type == "category"]{ "id": _id, "slug": slug.current, name }');
    const url = `https://${PROJECT}.api.sanity.io/v2024-01-01/data/query/production?query=${q}`;
    return (await (await fetch(url)).json()).result;
  },
  route: (c) => `/category/${c.slug}/`,
  data: async (c, _page, { cms }) => ({
    name: c.name,
    // extra list constraint via the adapter's raw access, or filter client-side
    items: (await cms.list({ perPage: 100 })).filter((a) => a.category?._ref === c.id),
  }),
},
```

**Webhooks.** Sanity GROQ-powered webhooks fire on document changes; point them at hybld:

```
POST /rebuild   Header: x-hybld-secret: <secret>   Body: {"ids": ["<documentId>"]}
```

**Deletion sweep cron:** `0 3 * * *  npx hybld status --reconcile --prune`

All requests share hybld's HTTP layer: bounded concurrency, retry with backoff honoring `Retry-After`, per-run memoization, optional disk cache.

## Troubleshooting

| Symptom | Fix |
| --------- | ----- |
| Slightly stale content right after publish | `useCdn: true` serves cached reads; the next `--since` sweep catches up, or set `useCdn: false`. |
| Drafts appear in builds | Drafts only surface with a `token`; scope tokens to published-only for production configs. |
| Portable Text renders as JSON | `body` is Portable Text blocks; render with @portabletext/react (or equivalent) in your page component. |

## License

MIT
