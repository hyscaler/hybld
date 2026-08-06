# @hybld/next

Next.js render backend for [hybld](https://github.com/MdMotahir/hybld), incremental static builds for CMS-backed `output: "export"` sites. hybld computes what changed; `next build` renders just those pages; hybld merges the output. Supports both the App Router and the Pages Router (including `_next/data` fan-out so client-side navigation stays current across incremental builds).

## Install

```bash
npm install -D hybld @hybld/next @hybld/adapter-wordpress
```

## Wire up

```js
// next.config.mjs
export default {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  serverExternalPackages: ["hybld", "@hybld/next", "jiti"],
};

// hybld.config.mjs  (Next projects must use .mjs)
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nextRenderer } from "@hybld/next/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: CMS_URL }),
  renderer: nextRenderer(),
  outDir: "site", // must differ from Next's "out"
  pages: { /* ... */ },
});
```

```jsx
// app/articles/[slug]/page.jsx
import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;
export async function generateStaticParams() {
  return hybldParams("article", (_data, job) => ({ slug: job.slug }));
}
export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });
  return <article>…</article>;
}
```

Then `hybld build --since last-build` rebuilds only the changed pages through one scoped `next build`.

Full guide: https://github.com/MdMotahir/hybld

## License

MIT
