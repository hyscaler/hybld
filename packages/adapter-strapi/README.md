# @hybld/adapter-strapi

Strapi CMS adapter for [hybld](https://github.com/MdMotahir/hybld), incremental static builds for CMS-backed sites.

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
  adapter: strapi({ baseUrl, contentType: "articles", token }),
  pages: { /* ... */ },
});
```

Handles Strapi v4 and v5 response shapes; incremental builds via filters[updatedAt]. Deletions: use hybld's reconcile sweep (`hybld status --reconcile --prune`).

All requests go through hybld's shared HTTP layer: bounded concurrency, retry with backoff honoring Retry-After, per-run memoization, and an optional cross-run disk cache.

Full guide and adapter capability matrix: https://github.com/MdMotahir/hybld

## License

MIT
