# @hybld/adapter-contentful

Contentful CMS adapter for [hybld](https://github.com/MdMotahir/hybld), incremental static builds for CMS-backed sites.

## Install

```bash
npm install -D hybld @hybld/adapter-contentful
```

## Use

```ts
// hybld.config.ts
import { defineConfig } from "hybld";
import { contentful } from "@hybld/adapter-contentful";

export default defineConfig({
  adapter: contentful({ space, accessToken, contentType }),
  pages: { /* ... */ },
});
```

Delivery API with skip/limit pagination; incremental builds via sys.updatedAt. Point host at preview.contentful.com for drafts. Deletions: use hybld's reconcile sweep.

All requests go through hybld's shared HTTP layer: bounded concurrency, retry with backoff honoring Retry-After, per-run memoization, and an optional cross-run disk cache.

Full guide and adapter capability matrix: https://github.com/MdMotahir/hybld

## License

MIT
