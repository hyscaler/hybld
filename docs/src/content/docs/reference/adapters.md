---
title: "CMS Adapters"
description: "WordPress, Strapi, Contentful, and Sanity presets; generic REST/GraphQL helpers; writing your own."
sidebar:
  order: 4
---
An adapter is any object implementing this interface (all content access goes through one):

```ts
interface CmsAdapter<TArticle = any> {
  name: string;
  count(): Promise<number>;
  listArticles(opts: { page, perPage, ...filters }): Promise<{ items: TArticle[]; hasMore: boolean }>;
  getArticle(ref: { id? , slug? }): Promise<TArticle | null>;
  listModifiedSince?(date, opts): Promise<{ items; hasMore }>;   // enables --since
  listDeletedSince?(date): Promise<Array<{ id?, slug? }>>;       // enables deletion handling in --since
  listTerms?(taxonomy): Promise<Array<{ id, slug, name, count? }>>;  // enables aggregate enumeration
  getPreview?(ref): Promise<TArticle | null>;                    // enables hybld preview
}
```

Capabilities are declared by which optional methods exist; hybld degrades with clear errors when a capability is missing (e.g. `--since` without `listModifiedSince`).

## Preset capability matrix

| Capability | wordpress | strapi | contentful | sanity |
| ------------ | ----------- | -------- | ------------ | -------- |
| `listModifiedSince` (incremental `--since`) | yes | yes | yes | yes |
| `listDeletedSince` (deletion handling) | yes, with `trackDeletes: true` | no (use `status --reconcile --prune`) | no (use `status --reconcile --prune`) | no (use `status --reconcile --prune`) |
| `listTerms` (aggregate enumeration) | yes (categories/tags) | no (enumerate from your own endpoint) | no | no |
| `getPreview` (draft previews) | yes (`status=any`, needs auth on real WP) | no | no (point `host` at preview.contentful.com instead) | no (use a token + `useCdn: false` against drafts) |

Missing capabilities degrade cleanly: deletions fall back to the weekly `hybld status --reconcile --prune` sweep (which deletes orphaned pages through the normal pipeline), and aggregates can always enumerate through a custom function in your config instead of `cms.listTerms`.

## Presets

### WordPress: `@hybld/adapter-wordpress`

```ts
import { wordpress } from "@hybld/adapter-wordpress";

wordpress({
  baseUrl: "https://cms.example.com",
  postType: "posts",                    // REST collection
  auth: { token } | { basic: { user, password } },
  trackDeletes: true,                   // listDeletedSince via ?status=trash (needs auth on real WP)
  query: { _embed: "1" },               // extra list params
  concurrency, requestsPerSecond,
})
```

Implements everything including `listTerms` (categories/tags) and `getPreview` (`status=any`, needs an authenticated user with edit permission on real WordPress).

### Strapi: `@hybld/adapter-strapi`

```ts
strapi({ baseUrl, contentType: "articles", token?, slugField?, query? })
```

Handles v4 (`data[].attributes`) and v5 (flat) shapes; `modified` is normalized from `updatedAt`; incremental via `filters[updatedAt][$gt]`; counts from `meta.pagination.total`.

### Contentful: `@hybld/adapter-contentful`

```ts
contentful({ space, accessToken, contentType, environment?, slugField?, host? })
```

Delivery API with skip/limit pagination; entries flattened to `{ id, modified, ...fields }`; incremental via `sys.updatedAt[gt]`. Point `host` at `preview.contentful.com` for draft content.

### Sanity: `@hybld/adapter-sanity`

```ts
sanity({ projectId, dataset, type: "post", apiVersion?, token?, useCdn?, normalize? })
```

GROQ-based (hand-written adapter, not the REST helper). Documents normalized to `{ id, modified, slug, ...doc }` from `_id`/`_updatedAt`/`slug.current`; incremental via `_updatedAt > $since`.

## Generic helpers (`hybld/adapters`)

For conventional APIs without a preset:

```ts
import { createRestAdapter, createGraphqlAdapter } from "hybld/adapters";

const rest = createRestAdapter({
  listUrl: "https://api.example.com/articles",
  itemUrl?: (ref) => string,            // default: listUrl/{id} or listUrl?slug=
  pageParam?: "page",
  offsetParam?: "skip",                 // offset-based APIs; used instead of pageParam
  perPageParam?: "per_page",
  modifiedAfterParam?: "modified_after",// omit if the API cannot filter by date
  count?: { header: "X-Total-Count" } | { url, pick } | { pick: (body) => number },
  pickList?: (body) => any[],
  pickItem?: (body) => any,
  termsUrl?: (taxonomy) => string,
  pickTerms?: (body) => terms[],
  headers?, query?, concurrency?, requestsPerSecond?,
});

const gql = createGraphqlAdapter({
  endpoint,
  list: { query, pick, hasMore? },      // variables: { page, perPage }
  item: { query, pick },                // variables: { id, slug }
  modifiedSince?: { query, pick },      // variables: { since, page, perPage }
  terms?: { query, pick },              // variables: { taxonomy }
  count?: { query, pick },
  headers?,
});
```

Extra keys passed to `listArticles` (from `cms.list({ category_slug: "tech" })`) become query params on REST list requests.

## The shared HTTP layer

All helper-built adapters route through `createFetcher` (also exported from `hybld`):

- Bounded concurrency and optional requests/second throttle.
- Retry with exponential backoff and jitter on 429/5xx, honoring `Retry-After` (both the seconds and HTTP-date forms).
- A 30-second per-request timeout (`timeoutMs`), so one hung CMS connection cannot stall a build.
- Per-run GET memoization (identical requests within one build hit the CMS once; cleared at every build start).
- Optional cross-run disk cache (`cms.cache` config), automatically bypassed for modified-since and trash queries.

Hand-written adapters can opt in by building on `createFetcher` and exposing it as `adapter.fetcher` (this also feeds the summary's request count and lets the builder enable the disk cache).

## Writing a custom adapter

Any object satisfying the interface works, inline in the config:

```ts
const adapter: CmsAdapter = {
  name: "my-api",
  count: async () => (await fetch(`${API}/count`)).json(),
  listArticles: async ({ page, perPage }) => { ... },
  getArticle: async (ref) => { ... },
  listModifiedSince: async (date, { page, perPage }) => { ... },  // strongly recommended
};
```

Guidelines: paginate everything (never return the whole catalog in one response), implement `listModifiedSince` if the API allows it at all (it powers the entire incremental story), and treat "no longer publicly visible" (unpublished, trashed, private) as deleted in `listDeletedSince`.
