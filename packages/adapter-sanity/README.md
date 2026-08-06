# @hybld/adapter-sanity

Sanity adapter for [hybld](https://www.npmjs.com/package/hybld), incremental static builds for CMS-backed sites, GROQ-based against the Sanity API.

## Install

```bash
npm install -D hybld @hybld/adapter-sanity
```

## Use

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { sanity } from "@hybld/adapter-sanity";

export default defineConfig({
  adapter: sanity({
    projectId: process.env.SANITY_PROJECT,
    dataset: "production",
    type: "post",                        // GROQ _type filter
    apiVersion: "2024-01-01",
    token: process.env.SANITY_TOKEN,     // for private datasets / draft access
    useCdn: true,
  }),
  pages: { /* ... */ },
});
```

## Options

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `projectId`, `dataset` | required | Sanity project and dataset. |
| `type` | required | The document `_type` this collection queries. |
| `apiVersion` | recent | Sanity API version date. |
| `token` | none | Auth for private datasets; combine with `useCdn: false` to reach drafts. |
| `useCdn` | `true` | CDN endpoint for cached reads; disable for freshest data/drafts. |
| `normalize` | built-in | Override the document -> article normalization. |

## Capabilities

| hybld feature | Supported |
| --------------- | ----------- |
| Incremental `--since` builds | yes, via `_updatedAt > $since` |
| Deletion handling in `--since` | no; run `hybld status --reconcile --prune` on a schedule |
| Taxonomy enumeration (`cms.listTerms`) | no; enumerate with your own GROQ in the config |
| Draft previews | via `token` + `useCdn: false`, not `hybld preview` |

Documents are normalized to `{ id, modified, slug, ...doc }` from `_id`/`_updatedAt`/`slug.current`. All dynamic values are passed as bound GROQ parameters (no query injection from config values).

All requests go through hybld's shared HTTP layer: bounded concurrency, retry with exponential backoff honoring `Retry-After`, per-run memoization, and an optional cross-run disk cache.

## License

MIT
