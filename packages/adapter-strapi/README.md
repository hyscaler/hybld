# @hybld/adapter-strapi

Strapi adapter for [hybld](https://www.npmjs.com/package/hybld), incremental static builds for CMS-backed sites. Handles both Strapi v4 (`data[].attributes`) and v5 (flat) response shapes.

## Install

```bash
npm install -D hybld @hybld/adapter-strapi
```

## Use

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { strapi } from "@hybld/adapter-strapi";

export default defineConfig({
  adapter: strapi({
    baseUrl: "https://cms.example.com",
    contentType: "articles",            // plural API id
    token: process.env.STRAPI_TOKEN,    // API token (Settings -> API Tokens)
    slugField: "slug",                  // field used for slug lookups
    query: { populate: "*" },           // extra params on list requests
  }),
  pages: { /* ... */ },
});
```

## Options

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `baseUrl` | required | Strapi origin; requests go to `<baseUrl>/api/<contentType>`. |
| `contentType` | required | The collection's plural API id. |
| `token` | none | Bearer token for private content. |
| `slugField` | `"slug"` | Which field `--slugs` lookups filter on. |
| `query` | none | Extra query params merged into list requests (e.g. `populate`). |

## Capabilities

| hybld feature | Supported |
| --------------- | ----------- |
| Incremental `--since` builds | yes, via `filters[updatedAt][$gt]` |
| Deletion handling in `--since` | no; run `hybld status --reconcile --prune` on a schedule |
| Taxonomy enumeration (`cms.listTerms`) | no; enumerate from your own endpoint in the config |
| Draft previews | no; query draft entries with your own token setup |

Articles are normalized so `data()` sees a flat object regardless of Strapi version; `modified` is normalized from `updatedAt`, and counts come from `meta.pagination.total` (enabling parallel catalog listing).

All requests go through hybld's shared HTTP layer: bounded concurrency, retry with exponential backoff honoring `Retry-After`, per-run memoization, and an optional cross-run disk cache.

## License

MIT
