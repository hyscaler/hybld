# @hybld/adapter-wordpress

WordPress REST adapter for [hybld](https://www.npmjs.com/package/hybld), incremental static generation for CMS-backed sites. This is the most complete preset: incremental modified-since builds, deletion tracking, taxonomy enumeration, and draft previews all supported.

## Install

```bash
npm install -D hybld @hybld/adapter-wordpress
```

## Usage

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";

export default defineConfig({
  adapter: wordpress({
    baseUrl: "https://cms.example.com",
    postType: "posts",
    auth: { token: process.env.WP_TOKEN },
    trackDeletes: true,
    query: { _embed: "1" },
    concurrency: 8,
    requestsPerSecond: 20,
  }),

  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      // WordPress REST shape: rendered fields live under .rendered
      data: (a) => ({
        title: a.title.rendered,
        html: a.content.rendered,
        excerpt: a.excerpt.rendered,
        date: a.date,
        // with query: { _embed: "1" }, terms and media ride along:
        categories: a._embedded?.["wp:term"]?.[0]?.map((t) => t.slug) ?? [],
        hero: a._embedded?.["wp:featuredmedia"]?.[0]?.source_url ?? null,
      }),
      dependents: (a) => ["/"],
    },
    category: {
      // listTerms is implemented by this preset: categories, tags, custom taxonomies
      enumerate: async ({ cms }) => cms.listTerms("category"),
      paginate: { perPage: 20 },   // term.count enables page-count derivation
      route: (c, page) => (page === 1 ? `/category/${c.slug}/` : `/category/${c.slug}/page/${page}/`),
      data: async (c, page, { cms }) => ({
        name: c.name,
        items: await cms.list({ perPage: 20, page, categories: c.id }),
      }),
    },
  },
});
```

Extra keys passed to `cms.list({...})` become query params on the REST request, so all of WordPress's list filters (`categories`, `tags`, `author`, `search`, `orderby`, ...) work directly.

## Options

| Option | Default | Purpose |
| -------- | --------- | --------- |
| `baseUrl` | required | WordPress origin; requests go to `<baseUrl>/wp-json/wp/v2/<postType>`. |
| `postType` | `"posts"` | REST collection. For custom post types, use the type's `rest_base` (it must have `show_in_rest: true`). |
| `auth` | none | `{ token }` (Bearer/JWT) or `{ basic: { user, password } }` (WordPress application passwords work here). |
| `trackDeletes` | `false` | Deletion detection via `?status=trash&modified_after=` (paginated past 100 items). Requires an authenticated user with edit permission on real WordPress. |
| `query` | none | Extra params merged into list requests (e.g. `_embed: "1"` to embed terms/media). |
| `concurrency` | 4 | Parallel requests through hybld's shared HTTP layer. |
| `requestsPerSecond` | off | Hard throttle for rate-limited hosts. |

## Capability matrix

| hybld feature | Support | Notes |
| --------------- | --------- | ------- |
| `--since` incremental builds | yes | `modified_after` on the REST list. |
| Deletion handling in `--since` | yes | with `trackDeletes: true`; treats trashed as deleted. Without it, schedule `hybld status --reconcile --prune`. |
| Taxonomy enumeration (`cms.listTerms`) | yes | `"category"`, `"tag"`, or a custom taxonomy's rest_base; terms carry `count` for pagination. |
| Draft previews (`hybld preview`) | yes | fetches with `status=any`; requires auth with edit permission. |
| Parallel catalog listing | yes | counts from the `X-WP-Total` header. |

## Recipes

**Multiple post types as separate collections:**

```ts
pages: {
  article: { route: ..., data: ... },                     // posts
  caseStudy: {
    collection: true,
    adapter: wordpress({ baseUrl: CMS, postType: "case-studies" }),
    route: (c) => `/case-studies/${c.slug}/`,
    data: (c) => ({ title: c.title.rendered, html: c.content.rendered }),
  },
}
// build one: hybld build --ids caseStudy:42
```

**Webhook wiring.** Any WordPress webhook plugin that POSTs the post ID works with hybld's built-in endpoint:

```
POST https://build.example.com:4600/webhook/wordpress
Header: x-hybld-secret: <secret>
Body: { "post_id": 123 }        # also accepts post.ID / id shapes
```

**Draft previews.** `hybld preview --slugs my-draft` renders the draft to a noindexed `/_preview/` path (React + Vite backend). The preview fetch uses `status=any`, so `auth` must be set.

**CMS-hosted images.** Combine with hybld's `images: { origins: ["https://cms.example.com"] }` so article images are downloaded into the output and rewritten instead of hotlinking WordPress.

All requests share hybld's HTTP layer: bounded concurrency, retry with exponential backoff honoring `Retry-After` (WordPress hosting rate limits are handled gracefully), per-run memoization, optional cross-run disk cache.

## Troubleshooting

| Symptom | Fix |
| --------- | ----- |
| `WordPress trash query failed: 401/403` | `trackDeletes` needs authenticated edit permission; set `auth` or disable and use `status --reconcile --prune`. |
| Custom post type returns 404 | Use the type's `rest_base`, and ensure it is registered with `show_in_rest: true`. |
| Previews return "article not found" | The draft fetch needs `auth` with edit permission. |
| Rate-limit errors from managed hosting | Lower `concurrency`, set `requestsPerSecond`; retries with backoff are automatic but staying under the limit is better. |

## License

MIT
