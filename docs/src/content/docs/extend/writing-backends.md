---
title: "Writing Render Backends"
description: "The RenderBackend contract and delegatedRenderer for adding new frameworks."
sidebar:
  order: 1
---
hybld's engine (manifest, diffing, scoping, dependents, sitemap, feed, redirects, sync, serve) is framework-agnostic; only rendering is pluggable. Three backends ship (react-vite, next, astro); this guide is for adding more (Vue/Svelte/Solid with Vite, or delegated backends for Nuxt/SvelteKit-style frameworks).

## The contract

```ts
interface RendererFactory {
  name: string;
  mode: "owned" | "delegated";
  create(config: ResolvedConfig, opts: { externalClientBuild?: boolean }): RenderBackend;
}

interface RenderBackend {
  name: string;
  mode: "owned" | "delegated";
  prepare(opts: { clean: boolean }): Promise<void>;   // build artifacts / compute the hash
  readonly assetGraphHash: string;                    // owned: artifact hash; delegated: SOURCE fingerprint
  readonly assetFiles: string[];                      // files (relative to outDir) in the current graph
  readonly assetDirs: string[];                       // hashed-asset dirs, e.g. ["assets"], ["_next/static"]
  renderBatch(jobs: RenderJob[], opts?: { noindex?: boolean }): Promise<RenderedPage[]>;
  pageSidecars(outputPath: string): string[];         // framework files that travel with a page
  finalizeMerge?(ctx: { deletedPageOutputs: string[] }):  // optional post-merge housekeeping
    { created: string[]; updated: string[]; removals: string[] };
  destroy(): void;
}
```

`finalizeMerge` is optional and runs once per build after pages and assets are merged into the cumulative outDir. Use it for framework-specific housekeeping that spans the whole output (the Next backend uses it to fan the Pages Router `_next/data/<buildId>` JSON across retained buildId dirs and prune old ones). Its `removals` join the run's deferred, post-commit deletions; `created`/`updated` feed the changed-files report.

`RenderJob` carries `{ route, pageType, data, article?, slug?, id?, item?, page? }`. Results are one of:

- `{ route, kind: "html", html }`: the engine post-processes (images), writes, and records the page.
- `{ route, kind: "files", outputPath, files: [{ absPath, relPath }] }`: already-rendered files the engine merges (with HTML/sidecar post-processing).
- `{ route, kind: "extra", outputPath, files }`: pages emitted beyond the requested scope (static framework routes); merged with page types preserved from existing manifest rows.
- `{ route, kind: "failed", error }`.

## The easy path: delegatedRenderer

For any framework with a "list my dynamic routes" hook and a static build command, you rarely need to implement `RenderBackend` yourself:

```ts
import { delegatedRenderer } from "hybld";

export function myFrameworkRenderer(opts = {}) {
  return delegatedRenderer({
    name: "myfw",
    buildCommand: ["npx", "myfw", "build"],
    frameworkOutDir: "build",              // must differ from hybld's outDir
    sourceDirs: ["src", "public", "myfw.config.js", "package.json"],  // fingerprint inputs
    assetDirs: ["_myfw"],
    pageFileCandidates: (route) => [...],  // route -> emitted file paths to try
    sidecarsFor?: (primary) => [...],      // per-page framework payloads (Next: RSC .txt)
    finalizeOutDir?: ({ outDir, stagingDir, deletedPageOutputs }) => ({  // optional, see finalizeMerge
      created: [], updated: [], removals: [],
    }),
    env?: { ... },
  });
}
```

The delegated base handles: NDJSON scope writing, subprocess execution (with `HYBLD_SCOPE`, `HYBLD_INTERNAL`, and the resolved config path in `HYBLD_CONFIG` all set), mapping requested routes to emitted files, discovering extras, collecting hashed asset files, copying every other framework output (your `public/` files, robots.txt, favicons) into the deployed site, and skipping the framework build entirely when the batch is empty. The subprocess stdout/stderr buffer is capped (tail kept for error reporting).

Your framework-side helper then reads the scope. Import from **`hybld/scope`** (a lightweight module graph with no Vite/worker imports) and shield it from the framework's bundler:

```ts
// helpers for pages: scoped during hybld runs, full catalog otherwise
import { scopedJobs, scopedParams, scopedData } from "hybld/scope";
```

Use `scopedJobs` when the route-listing hook also supplies the page's props (Astro's `getStaticPaths`), so each job carries its `data`. Use `scopedParams` when the hook only needs params and data is fetched separately (Next's `generateStaticParams` + `hybldData`): on plain framework builds it skips loading page data, avoiding one CMS `data()` call per catalog page. Full-catalog enumeration is memoized per process (60s) so a plain build does not re-walk the catalog for every page.

If the framework bundles server code with webpack (like Next), load it via `import(/* webpackIgnore: true */ "hybld/scope")` so the bundler never processes the graph. Ship the renderer factory on a separate subpath (like `@hybld/next/renderer`) so page code never imports the heavy engine graph.

## Rules learned the hard way

1. **Delegated asset hashes must be source fingerprints.** Hashing build output marks the whole catalog code-stale after every run when the framework emits per-build runtime files (Next's buildId). `recordAssetGraph` unions files per hash for exactly this reason.
2. **Never let a batch produce empty dynamic-route params.** Next's export hard-fails on an empty `generateStaticParams`. The engine pads every delegated batch with one page per dynamic route type (from the manifest, or one live CMS item on a fresh manifest), and if freshness-skipping would otherwise empty a type, it promotes one already-fresh page back into the batch (reported as skipped). A new backend gets both for free.
3. **Singleton page data must be in every scope file.** Static routes rebuild on every framework run and read their data through the helpers; the engine force-includes singletons in every delegated batch.
4. **Declare sidecars.** Anything the framework emits next to a page must be declared in `sidecarsFor` so merges, deletions, moves, and image-URL rewriting keep HTML and payloads consistent.
5. **The framework build must never block an HTTP request.** serve-mode regen on delegated backends responds `503 Retry-After` and rebuilds asynchronously; keep that behavior.
6. **Owned backends should fingerprint sources for build reuse.** The react-vite backend skips Vite entirely when sources are unchanged; it is the difference between 1s and 0.1s CLI builds.

## Owned backends

For a Vite-based framework (Vue, Svelte, Solid), the react-vite backend (`packages/hybld/src/backends/react-vite.ts` wrapping `renderer.ts`) is the template: Vite client build with `manifest: true`, SSR build of a user entry, a worker pool calling the entry's render function, template placeholder injection, and a serialized data payload for hydration. Most of it is framework-neutral already; the differences are the entry-function conventions and the hydration snippet.
