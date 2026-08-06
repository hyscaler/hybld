---
title: "Next.js"
description: "The delegated Next backend: static export requirements, page helpers, and gotchas."
sidebar:
  order: 2
---
hybld's Next backend targets **static export** (`output: "export"`): the deployment mode where Next itself has no incremental story. If your site runs on a Next server, prefer Next's native ISR (`revalidatePath`/`revalidateTag`); hybld adds little there.

Working reference: `examples/next-demo`.

## Hard requirements

```js
// next.config.mjs
const nextConfig = {
  output: "export",
  trailingSlash: true,   // required: emitted paths become route/index.html (+ index.txt RSC payloads)
  images: { unoptimized: true },
  serverExternalPackages: ["hybld", "@hybld/next", "jiti"],
};
export default nextConfig;
```

And the hybld config **must be plain JavaScript** (`hybld.config.mjs`, not `.ts`): the helper fallback loads it inside Next's build workers, where TypeScript configs cannot be imported.

```js
// hybld.config.mjs
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nextRenderer } from "@hybld/next/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: CMS_URL, trackDeletes: true }),
  renderer: nextRenderer(),
  outDir: "site",          // must differ from Next's "out"
  pages: { ... },
});
```

## Page wiring

Dynamic routes read the scope through the helpers. `hybldParams` returns only the scoped routes during hybld runs, and the full catalog during plain `next build` or `next dev`:

```jsx
// app/articles/[slug]/page.jsx
import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;

export async function generateStaticParams() {
  return hybldParams("article", (_data, job) => ({ slug: job.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });
  return { title: article.title, description: stripTags(article.excerpt) };
}

export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });  // scope-first: no CMS call during hybld runs
  return <article>...</article>;
}
```

Enumerated aggregates work the same way (`hybldParams("category", (_d, job) => ({ slug: job.item.slug }))`). Static routes (home) just call `hybldData("home")`: their data is included in every scope file because Next rebuilds static routes on every build.

Head/meta tags are Next's job (`generateMetadata`), not hybld's.

## Pages Router

The Pages Router works with the same helpers plus a line of glue in `getStaticPaths`, and the backend merges the Pages Router's `_next/data/<buildId>/` JSON (what `next/link` navigation fetches) alongside the HTML. Because every `next build` mints a new buildId while visitors sit on HTML with older buildIds baked in, each build's fresh JSON is fanned out to every retained buildId directory, so client-side navigation always serves current props. `nextRenderer({ keepBuildIds: n })` controls how many buildId data dirs are retained (default 3; visitors on HTML older than that degrade to a full-page navigation). Working reference: `examples/nextpages-demo`.

```jsx
// pages/articles/[slug].jsx
import { hybldParams, hybldData } from "@hybld/next";

export async function getStaticPaths() {
  const params = await hybldParams("article", (_data, job) => ({ slug: job.slug }));
  return { paths: params.map((p) => ({ params: p })), fallback: false };
}

export async function getStaticProps({ params }) {
  const article = await hybldData("article", { slug: params.slug });
  return { props: { article } };
}
```

Head tags go through `next/head`; everything else (requirements, `.mjs` config, build flow, limitations) is identical to the App Router.

## How a build works

1. hybld resolves the scope and dependents, writes `.hybld/scope.ndjson`.
2. Runs `next build` (each incremental run costs one Next build, ~5s in the demo; batch it accordingly).
3. Maps emitted `route/index.html` + `route/index.txt` (RSC payload) pairs back to routes; merges them and `_next/static` assets (append-only) into `outDir`; static routes emitted beyond the scope merge as extras, and everything else Next emits (your `public/` files, robots.txt, favicons) is overwrite-copied so it reaches the deployed site.
4. Runs the shared post-steps: manifest, sitemap, feed, redirects, changed-files report.

Details handled for you: every batch carries at least one page per dynamic route type (Next's export refuses an empty `generateStaticParams`; padding comes from the manifest, or one live CMS item on a first-ever build), RSC sidecars travel with their pages through merges, deletions, moves, and image-URL rewriting, and the asset graph hash is a source fingerprint (Next's per-build buildId files would otherwise mark everything code-stale after every run).

## Limitations on this backend

- **webpack builds only.** The helpers keep hybld's module graph out of Next's bundle using a `webpackIgnore` dynamic import plus `serverExternalPackages`, both webpack mechanisms. `next build --turbopack` is untested and likely bundles the graph; don't use it with hybld yet.

- No `hybld preview` (each draft would cost a full Next build); use Next's draft mode.
- serve-mode regen-on-miss responds `503` + `Retry-After` and rebuilds asynchronously.
- `next dev` and plain `next build` fall back to full-catalog enumeration through your config: dev servers cache that config per process (restart to pick up CMS config changes), and plain full builds make one `getArticle` call per page. On that fallback path `hybldParams` does NOT load page data (its `data` argument is undefined); derive params from the `job` fields (`slug`, `id`, `item`, `page`), which is what the examples do.
