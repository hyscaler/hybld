# @hybld/next

Next.js render backend for [hybld](https://www.npmjs.com/package/hybld), incremental static builds for CMS-backed **static export** sites (`output: "export"`), the deployment mode where Next itself has no incremental story. Publish one article; hybld runs one scoped `next build` and merges just that page (and its listings) into your cumulative site. Supports the **App Router and the Pages Router**.

If your site runs on a Next server, prefer Next's native ISR; hybld targets static hosting.

## Install

```bash
npm install -D hybld @hybld/next @hybld/adapter-wordpress
```

Requires Node >= 22.5.

## Hard requirements

```js
// next.config.mjs
const nextConfig = {
  output: "export",        // hybld drives static export only
  trailingSlash: true,     // REQUIRED: emitted paths become route/index.html (+ RSC payloads)
  images: { unoptimized: true },
  serverExternalPackages: ["hybld", "@hybld/next", "jiti"],  // keep hybld out of Next's bundle
};
export default nextConfig;
```

The hybld config **must be plain JavaScript** (`hybld.config.mjs`, not `.ts`): the helper fallback loads it inside Next's build workers, where TypeScript configs cannot be imported.

```js
// hybld.config.mjs
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nextRenderer } from "@hybld/next/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: process.env.CMS_URL, trackDeletes: true }),
  renderer: nextRenderer(),   // options: { nextOutDir, buildCommand, sourceDirs, keepBuildIds }
  outDir: "site",             // MUST differ from Next's "out" (staging vs cumulative site)
  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({ title: a.title.rendered, html: a.content.rendered }),
      dependents: () => ["/"],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({ latest: await cms.list({ perPage: 10 }) }),
    },
  },
  sitemap: { enabled: true, baseUrl: "https://www.example.com" },
});
```

## App Router wiring

`hybldParams` returns only the scoped routes during hybld runs, and the full catalog during plain `next build` / `next dev`. `hybldData` reads props from the scope with zero CMS calls during hybld runs:

```jsx
// app/articles/[slug]/page.jsx
import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;

export async function generateStaticParams() {
  // Derive params from `job` fields (slug/id/item/page); the data argument is
  // undefined on plain builds by design (pages fetch via hybldData instead).
  return hybldParams("article", (_data, job) => ({ slug: job.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });
  return { title: article.title };
}

export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });
  return <article><h1>{article.title}</h1><div dangerouslySetInnerHTML={{ __html: article.html }} /></article>;
}
```

Enumerated aggregates: `hybldParams("category", (_d, job) => ({ slug: job.item.slug }))`. Static routes (home) just call `hybldData("home")`; their data rides in every scope file. Head/meta tags are Next's job (`generateMetadata`).

## Pages Router wiring

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

The backend merges the Pages Router's `_next/data/<buildId>/` JSON alongside the HTML and fans each build's fresh JSON out to every retained buildId directory, so client-side `next/link` navigation always serves current props even from pages built in older runs. `nextRenderer({ keepBuildIds: n })` controls retention (default 3).

## How a build works

1. hybld resolves the changed pages and their dependents, writes the scope file.
2. Runs `next build`; your `generateStaticParams`/`getStaticPaths` see only the scoped routes.
3. Merges emitted HTML + RSC payloads back into `outDir` (append-only hashed assets; your `public/` files, robots.txt, and favicons are overwrite-copied so they reach the deployed site).
4. Maintains the manifest, sitemap, feed, redirects, and the changed-files deploy report.

Handled for you: batch padding (Next's export refuses an empty `generateStaticParams`), RSC sidecars traveling with pages through merges/deletions/moves, and source-fingerprint code-staleness (Next's per-build buildId files would otherwise mark everything stale every run).

## Build and operate

```bash
hybld build --all                  # first full build
hybld build --since last-build     # incremental sweep (cron this)
hybld build --slugs my-article     # webhook-style targeted build
hybld serve --secret "$SECRET"     # webhook server (503 + Retry-After regen on this backend)
```

## Limitations

- **webpack builds only**: `next build --turbopack` is untested and likely bundles the hybld graph.
- Each incremental run costs one `next build` (~5s+): persist `.next/cache` in CI and let webhook coalescing batch editor bursts.
- No `hybld preview` here; use Next's draft mode.
- `next dev` caches the catalog config per process (restart after config changes); plain `next build` enumerates the full catalog, so drive production builds through hybld.

## License

MIT
