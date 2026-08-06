# @hybld/adapter-contentful

Contentful adapter for [hybld](https://www.npmjs.com/package/hybld), incremental static builds for CMS-backed sites, on the Content Delivery API.

## Install

```bash
npm install -D hybld @hybld/adapter-contentful
```

## Use

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { contentful } from "@hybld/adapter-contentful";

export default defineConfig({
  adapter: contentful({
    space: process.env.CTF_SPACE,
    accessToken: process.env.CTF_TOKEN,
    contentType: "article",
    environment: "master",
    slugField: "slug",
    // host: "preview.contentful.com",   // Preview API for draft content
  }),
  pages: { /* ... */ },
});
```

## Options

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `space`, `accessToken` | required | Space id and CDA token. |
| `contentType` | required | The entry content type id. |
| `environment` | `"master"` | Contentful environment. |
| `slugField` | `"slug"` | Which field `--slugs` lookups filter on. |
| `host` | CDA | Point at `preview.contentful.com` (with a preview token) to build draft content. |

## Capabilities

| hybld feature | Supported |
| --------------- | ----------- |
| Incremental `--since` builds | yes, via `sys.updatedAt[gt]` |
| Deletion handling in `--since` | no; run `hybld status --reconcile --prune` on a schedule |
| Taxonomy enumeration (`cms.listTerms`) | no; enumerate from your own query in the config |
| Draft previews | via the Preview API host, not `hybld preview` |

Entries are flattened to `{ id, modified, ...fields }` so `data()` reads fields directly; skip/limit pagination and total counts enable parallel catalog listing.

All requests go through hybld's shared HTTP layer: bounded concurrency, retry with exponential backoff honoring `Retry-After`, per-run memoization, and an optional cross-run disk cache.

## License

MIT
