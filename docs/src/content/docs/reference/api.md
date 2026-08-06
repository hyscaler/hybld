---
title: "Programmatic API"
description: "createBuilder, build options, summaries, production webhook servers, error handling, and lower-level exports."
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

Create **one builder per process** and reuse it; that is where the warmth comes from. Creating a builder per request would re-pay artifact loading every time and contend on the build lock.

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
  reconcile?: true,             // prune CMS-side deletions (what status --reconcile --prune runs)

  // modifiers:
  clean?, dryRun?, force?, noDependents?, failFast?, concurrency?,
});
```

Builds queue and coalesce automatically: calls made while a build runs are serialized, and identical queued requests share one run. This is what makes naive webhook handlers safe: ten rapid saves of the same article become one build.

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

### Error handling contract

Two failure channels, treat them differently:

- **Per-page failures** (a `data()` threw, a render crashed, an article vanished mid-build) do NOT reject the promise. They land in `summary.failed` with per-route errors, the rest of the batch completes, and the `--since` cursor is held back so the next sweep retries them. Check `summary.failed.length`.
- **Run-level failures** (config invalid, lock held and `wait: false`, CMS unreachable past retries, `--since` without adapter support) reject the promise. Catch and report; nothing was committed (the manifest transaction rolls back).

```ts
try {
  const summary = await builder.build({ since: "last-build" });
  if (summary.failed.length) notify(`hybld: ${summary.failed.length} page(s) failed`, summary.failed);
} catch (err) {
  notify(`hybld: build errored: ${err.message}`);
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

## Recipe: a production webhook server

The built-in server (below) covers the common case; this is the same thing written against the API for when you need custom routes, auth, or to embed hybld in an existing service:

```ts
import { createBuilder } from "hybld";
import { createServer } from "node:http";

const builder = await createBuilder({ wait: true, log: console.error });

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/on-publish") { res.writeHead(404).end(); return; }
  if (req.headers["x-secret"] !== process.env.WEBHOOK_SECRET) { res.writeHead(401).end(); return; }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const { id, deleted } = JSON.parse(body || "{}");
      // Deletions come through the --since path; a targeted build of a deleted
      // id would fail. Sweep instead when the webhook signals a deletion.
      const summary = deleted
        ? await builder.build({ since: "last-build" })
        : await builder.build({ ids: [id] });
      res.writeHead(summary.failed.length ? 207 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(summary));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
});

server.listen(4600, "127.0.0.1");

// A cron-equivalent inside the same process: the sweep and webhooks share the
// builder, so they serialize on its queue instead of fighting over the lock.
setInterval(() => {
  builder.build({ since: "last-build" }).catch((e) => console.error("sweep failed:", e));
}, 10 * 60 * 1000);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { server.close(); await builder.close(); process.exit(0); });
}
```

Wire the deploy step to the summary: after any build with `built/deleted/moved` non-empty, read `summary.reportPath` and ship the listed files (see [Deployment](/operate/deployment/#deploying-the-output)).

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

## Recipe: chunked builds driven programmatically

```ts
// One process per chunk (CI matrix), then a merge step:
const summary = await builder.build({ chunk: { index: Number(process.env.CHUNK), total: 10 } });

// Merge step (separate job), using the Manifest directly:
import { Manifest } from "hybld";
const m = new Manifest(".hybld/manifest.db");
for (const db of chunkDbPaths) m.merge(db);   // keeps the newer row per route
m.close();
```

## Lower-level exports

| Export | Purpose |
| -------- | --------- |
| `defineConfig`, `loadConfig`, `validateConfig` | Config authoring and loading. |
| `createRestAdapter`, `createGraphqlAdapter`, `createFetcher` | Adapter building blocks. |
| `Manifest` | Direct manifest access (rows, meta, merge, export/import). |
| `syncOutput`, `pushManifest`, `pullManifest` | Deploy-diff application and manifest transport. |
| `reactVite`, `delegatedRenderer`, `DelegatedBackend` | Render backend factories (see [Writing render backends](/extend/writing-backends/)). |
| `listJobsForType`, `listParamsForType`, `loadJobData`, `readScope`, `scopedJobs`, `scopedParams`, `scopedData` | The machinery behind the framework helpers (`hybld/scope` is the lightweight subpath safe for framework bundles). |
| `OutputWriter`, `routeToOutputPath`, `Redirects`, `writeFeed`, `ImageLocalizer` | Output-layer utilities. |
