# @hybld/astro

Astro render backend for [hybld](https://github.com/MdMotahir/hybld), incremental static builds for CMS-backed Astro sites. hybld computes what changed; `astro build` renders just those pages; hybld merges the output into a cumulative site.

## Install

```bash
npm install -D hybld @hybld/astro @hybld/adapter-wordpress
```

## Wire up

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { astroRenderer } from "@hybld/astro/renderer";

export default defineConfig({
  adapter: wordpress({ baseUrl: CMS_URL }),
  renderer: astroRenderer(),
  outDir: "site", // must differ from Astro's "dist"
  pages: { /* ... */ },
});
```

```astro
---
// src/pages/articles/[slug].astro
import { hybldPaths } from "@hybld/astro";

export async function getStaticPaths() {
  return hybldPaths("article", (data, job) => ({
    params: { slug: job.slug },
    props: { article: data },
  }));
}
const { article } = Astro.props;
---
```

Add `vite: { ssr: { external: ["hybld", "@hybld/astro", "@hybld/adapter-wordpress", "jiti"] } }` to your astro.config so Astro's SSR bundle does not process the hybld graph.

Then `hybld build --since last-build` rebuilds only the changed pages through one scoped `astro build`.

Full guide: https://github.com/MdMotahir/hybld

## License

MIT
