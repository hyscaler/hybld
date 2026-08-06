# @hybld/adapter-sanity

Sanity CMS adapter for [hybld](https://github.com/MdMotahir/hybld), incremental static builds for CMS-backed sites.

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
  adapter: sanity({ projectId, dataset, type: "post" }),
  pages: { /* ... */ },
});
```

GROQ-based; incremental builds via _updatedAt. Deletions: use hybld's reconcile sweep.

All requests go through hybld's shared HTTP layer: bounded concurrency, retry with backoff honoring Retry-After, per-run memoization, and an optional cross-run disk cache.

Full guide and adapter capability matrix: https://github.com/MdMotahir/hybld

## License

MIT
