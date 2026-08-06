# @hybld/adapter-wordpress

WordPress REST adapter for [hybld](https://www.npmjs.com/package/hybld), incremental static builds for CMS-backed sites. The most complete preset: incremental modified-since queries, deletion tracking, taxonomy listing, and draft previews.

## Install

```bash
npm install -D hybld @hybld/adapter-wordpress
```

## Use

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";

export default defineConfig({
  adapter: wordpress({
    baseUrl: "https://cms.example.com",
    postType: "posts",                    // REST collection (custom post types work too)
    auth: { token: process.env.WP_TOKEN },            // or { basic: { user, password } }
    trackDeletes: true,                   // deletion handling via ?status=trash (needs auth on real WP)
    query: { _embed: "1" },               // extra params on list requests
    concurrency: 8,
    requestsPerSecond: 20,
  }),
  pages: { /* ... */ },
});
```

## Options

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `baseUrl` | required | The WordPress origin; requests go to `<baseUrl>/wp-json/wp/v2/...`. |
| `postType` | `"posts"` | REST collection name (use your custom post type's rest_base). |
| `auth` | none | `{ token }` (Bearer/JWT) or `{ basic: { user, password } }` (application passwords). |
| `trackDeletes` | `false` | Implements deletion detection via `?status=trash&modified_after=` (paginated). Requires an authenticated user with edit permission on real WordPress. |
| `query` | none | Extra query params merged into list requests (e.g. `_embed`). |
| `concurrency`, `requestsPerSecond` | 4 / off | Rate limiting through hybld's shared HTTP layer. |

## Capabilities

| hybld feature | Supported |
| --------------- | ----------- |
| Incremental `--since` builds | yes, via `modified_after` |
| Deletion handling in `--since` | yes, with `trackDeletes: true` (otherwise use `hybld status --reconcile --prune`) |
| Taxonomy enumeration (`cms.listTerms`) | yes: categories, tags, custom taxonomies |
| Draft previews (`hybld preview`) | yes, via `status=any` (requires auth with edit permission) |

Counts come from the `X-WP-Total` header, so full catalogs are listed with parallel page fetches. All requests go through hybld's shared HTTP layer: bounded concurrency, retry with backoff honoring `Retry-After`, per-run memoization, and an optional cross-run disk cache.

## Field mapping notes

WordPress articles arrive in REST shape: `title.rendered`, `content.rendered`, `excerpt.rendered`, `modified`, `slug`, `id`. Your config's `data()` maps those to your page props; hybld's defaults for identity (`a.id`, `a.slug`) and modification time (`a.modified`) match WordPress out of the box.

## License

MIT
