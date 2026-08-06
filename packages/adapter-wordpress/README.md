# @hybld/adapter-wordpress

WordPress CMS adapter for [hybld](https://github.com/MdMotahir/hybld), incremental static builds for CMS-backed sites.

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
  postType: "posts",
  trackDeletes: true,   // deletion handling via status=trash (needs auth on real WP)
}),
  pages: { /* ... */ },
});
```

Implements the full adapter surface: incremental modified-since queries, deletion tracking, taxonomy listing (categories/tags), and draft previews.

All requests go through hybld's shared HTTP layer: bounded concurrency, retry with backoff honoring Retry-After, per-run memoization, and an optional cross-run disk cache.

Full guide and adapter capability matrix: https://github.com/MdMotahir/hybld

## License

MIT
