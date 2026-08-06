# @hybld/adapter-contentful

Contentful adapter for [hybld](https://www.npmjs.com/package/hybld), incremental static generation for CMS-backed sites, on the Content Delivery API (CDA).

## Install

```bash
npm install -D hybld @hybld/adapter-contentful
```

## Usage

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { contentful } from "@hybld/adapter-contentful";

export default defineConfig({
  adapter: contentful({
    space: process.env.CTF_SPACE,
    accessToken: process.env.CTF_TOKEN,   // Delivery API token
    contentType: "article",
    environment: "master",
  }),

  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      // Entries arrive FLATTENED: { id, modified (from sys.updatedAt), ...fields }
      // so your Contentful fields are read directly:
      data: (a) => ({
        title: a.title,
        body: a.body,                      // rich text: render with your own renderer in the page
        date: a.publishDate,
        heroUrl: a.hero?.fields?.file?.url ? `https:${a.hero.fields.file.url}` : null,
      }),
      dependents: () => ["/"],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({
        latest: (await cms.list({ perPage: 10, order: "-sys.updatedAt" })).map((a) => ({
          slug: a.slug, title: a.title,
        })),
      }),
    },
  },
});
```

Extra keys passed to `cms.list({...})` are forwarded as CDA query params, so Contentful's filters work directly: `cms.list({ "fields.category.sys.id": catId, order: "-fields.publishDate" })`.

## Options

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `space`, `accessToken` | required | Space id and CDA token. |
| `contentType` | required | The entry content type id. |
| `environment` | `"master"` | Contentful environment. |
| `slugField` | `"slug"` | Which field `--slugs` lookups filter on. |
| `host` | `cdn.contentful.com` | Set `preview.contentful.com` (with a Preview token) to build draft content, e.g. for a staging site. |

## Capability matrix

| hybld feature | Support | Notes |
| --------------- | --------- | ------- |
| `--since` incremental builds | yes | `sys.updatedAt[gt]`. |
| Deletion handling in `--since` | no | schedule `hybld status --reconcile --prune` (unpublished entries disappear from the CDA and get swept). |
| Taxonomy enumeration (`cms.listTerms`) | no | enumerate from your own query (e.g. a category content type, below). |
| Draft previews (`hybld preview`) | no | run a second config with `host: "preview.contentful.com"` for a staging build instead. |
| Parallel catalog listing | yes | skip/limit with totals. |

## Recipes

**Category archives from a category content type:**

```ts
category: {
  enumerate: async () => {
    const url = `https://cdn.contentful.com/spaces/${SPACE}/environments/master/entries?content_type=category&select=sys.id,fields.slug,fields.name&access_token=${TOKEN}`;
    const body = await (await fetch(url)).json();
    return body.items.map((e) => ({ id: e.sys.id, slug: e.fields.slug, name: e.fields.name }));
  },
  route: (c) => `/category/${c.slug}/`,
  data: async (c, _page, { cms }) => ({
    name: c.name,
    items: await cms.list({ "fields.category.sys.id": c.id, perPage: 20 }),
  }),
},
```

**Staging site on the Preview API:** duplicate the config with `host: "preview.contentful.com"` and a preview token, build into a separate `outDir`, deploy to a protected staging host.

**Webhooks.** Contentful webhooks (publish/unpublish) POST to hybld's generic endpoint:

```
POST /rebuild   Header: x-hybld-secret: <secret>   Body: {"ids": ["<entry sys.id>"]}
# unpublish events: {"since": "last-build"} sweeps + reconcile removes the page
```

All requests share hybld's HTTP layer: bounded concurrency, retry with backoff honoring `Retry-After` (Contentful's 429s are handled), per-run memoization, optional disk cache.

## Troubleshooting

| Symptom | Fix |
| --------- | ----- |
| Linked entries/assets are stubs | CDA returns links unless included: pass `cms.list({ include: 2 })` or resolve in `data()`. |
| Draft content missing | You are on the CDA (published only); use `host: "preview.contentful.com"` with a preview token. |
| Unpublished entries still on the site | Expected between reconcile runs; tighten the `--reconcile --prune` schedule. |

## License

MIT
