---
title: "Programmatic API"
description: "createBuilder, build options, summaries, the built-in server, and lower-level exports."
sidebar:
  order: 3
---
Everything the CLI does is available from Node; the CLI is a thin wrapper. The killer feature of the API is the **warm builder**: artifacts stay loaded between builds, so a webhook server rebuilds single pages in seconds (milliseconds of overhead on the react-vite backend).

## createBuilder

```ts
import { createBuilder } from "hybld";

const builder = await createBuilder({
  configFile?: string,          // default: discover hybld.config.* in cwd
  cwd?: string,
  wait?: boolean,               // wait for the build lock instead of failing
  log?: (msg: string) => void,
  externalClientBuild?: boolean // Vite plugin mode internals (react-vite only)
});
```

## builder.build(options)

```ts
const summary = await builder.build({
  // exactly one scope:
  all?: true,
  limit?: number,
  chunk?: { index: number; total: number },
  chunkSize?: number,
  routes?: string[],
  slugs?: string[],             // "type:slug" targets non-default collections
  ids?: Array<string | number>, // "type:id" likewise
  since?: "last-build" | string,
  stale?: true,                 // may combine with chunkSize as a batch limit

  // modifiers:
  clean?, dryRun?, force?, noDependents?, failFast?, concurrency?,
});
```

Builds queue and coalesce automatically: calls made while a build runs are serialized, and identical queued requests share one run. This is what makes naive webhook handlers safe:

```ts
app.post("/on-publish", async (req, res) => {
  const summary = await builder.build({ ids: [req.body.post_id] });
  res.json(summary);
});
```

### BuildSummary

```ts
{
  mode: string,
  built: string[], skipped: string[], deleted: string[],
  failed: Array<{ route, error }>,
  moved: Array<{ from, to }>,
  dependentsRebuilt: string[],
  cmsRequests: number,
  durationMs: number,
  assetGraphHash: string,
  reportPath?: string,          // .hybld/last-build.json (includes files.created/updated/deleted)
  dryRun?: boolean, plannedRoutes?: string[],
}
```

## Other builder methods

```ts
await builder.status();
// { totalPages, byPageType, codeStale, lastBuildAt, lastFullBuildAt, currentAssetGraphHash }

await builder.reconcile({ prune?: boolean });
// { orphanRoutes: string[] }  (built pages whose CMS item is gone; per collection)
// prune: true also deletes them through the build pipeline (files, manifest,
// dependents, sitemap/feed). Reconcile never advances the --since cursor.

await builder.preview({ slugs?, ids? });
// { built: [{ route, file }], failed }  (react-vite backend only)

await builder.gcAssets(dryRun?);
// { kept, deleted: string[], skipped?: string }

builder.backendMode;   // "owned" | "delegated"
builder.config;        // the resolved config

await builder.close(); // releases workers and the manifest; always call on shutdown
```

## The built-in server

```ts
import { createBuilder, startServer } from "hybld";

const builder = await createBuilder({ wait: true });
const server = startServer(builder, {
  port: 4600,
  host: "127.0.0.1",              // default; a wider bind needs secret or insecure
  secret: process.env.WEBHOOK_SECRET,
  insecure: false,               // allow a non-loopback bind without a secret (not recommended)
  serveStatic: true,
  regenOnMiss: true,
  log: console.error,
});
```

Same endpoints as `hybld serve` (see [CLI reference](/reference/cli/)). Binds to loopback by default; binding wider without a `secret` throws unless `insecure: true`. POST bodies are capped at 1 MB and the secret is compared in constant time.

## Lower-level exports

| Export | Purpose |
| -------- | --------- |
| `defineConfig`, `loadConfig`, `validateConfig` | Config authoring and loading. |
| `createRestAdapter`, `createGraphqlAdapter`, `createFetcher` | Adapter building blocks. |
| `Manifest` | Direct manifest access (rows, meta, merge, export/import). |
| `syncOutput`, `pushManifest`, `pullManifest` | Deploy-diff application and manifest transport. |
| `reactVite`, `delegatedRenderer`, `DelegatedBackend` | Render backend factories (see [Writing render backends](/extend/writing-backends/)). |
| `listJobsForType`, `loadJobData`, `readScope`, `scopedJobs`, `scopedData` | The machinery behind the framework helpers (`hybld/scope` is the lightweight subpath safe for framework bundles). |
| `OutputWriter`, `routeToOutputPath`, `Redirects`, `writeFeed`, `ImageLocalizer` | Output-layer utilities. |
