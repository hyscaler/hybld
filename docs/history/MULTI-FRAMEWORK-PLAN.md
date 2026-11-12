# Multi-Framework Plan: React + Vite, Next.js, Astro

> Historical design document, kept for context. It records the plan as written before implementation and is not maintained; where it differs from the code or the docs site, the code and docs are correct.

Status: IMPLEMENTED (v1.0.0, 2026-07-20). All phases collapsed into one build at the user's direction; every gap from the deep analysis was addressed. See "Implementation notes" at the end for where reality diverged from this plan.
Date: 2026-07-20
Prerequisite reading: REQUIREMENTS.md (the engine this plan generalizes)

## 1. Goal

hybld currently solves incremental static builds for React + Vite only. This plan restructures it as a framework-agnostic incremental build engine with pluggable render backends, targeting three frameworks:

- React + Vite (today's behavior, unchanged for existing users)
- Next.js (App Router, static export)
- Astro

The engine (manifest, diffing, scoping, CMS adapters, rate limiting, dependents, sitemap, feed, redirects, changed-files report, sync, serve, locking) is already framework-agnostic. Only the renderer is coupled to React + Vite. The work is therefore: extract a renderer contract, keep the current renderer as the first backend, and add two framework backends with a different integration strategy.

## 2. The two integration strategies

There are exactly two viable ways to make a framework produce one page on demand, and picking the right one per framework is the core architectural decision.

### Strategy A: Owned rendering (React + Vite today; Vue/Svelte + Vite later)

hybld runs the framework's low-level pieces itself: Vite client + SSR builds, then `renderToString` per page against the SSR bundle. hybld controls the template, head injection, hydration payload, and worker pool.

- Pros: millisecond per-page renders once warm, full control, no framework build startup per run.
- Cons: only possible when the framework is a thin layer over Vite + a renderToString-style API.
- Verdict: correct for React + Vite (exists), straightforward to extend to Vue + Vite and Svelte + Vite later. NOT viable for Next.js (pages depend on the Next runtime: App Router, RSC, next/image, next/link) or Astro (.astro components need Astro's compiler and islands runtime).

### Strategy B: Delegated rendering, "scoped build and merge" (Next.js, Astro)

hybld never renders. Instead, per incremental run:

1. The engine resolves the build scope exactly as today (manifest diff, `--since`, targeted ids, dependents).
2. It writes a scope file (route list plus prefetched article data) to `.hybld/scope.json`.
3. It invokes the framework's own production build. A small helper package makes the user's dynamic-route declaration scope-aware: `generateStaticParams` (Next) or `getStaticPaths` (Astro) returns only the routes in the scope file instead of the full catalog.
4. The framework emits a partial site containing only those pages.
5. hybld merges the emitted files into the cumulative output directory (append-only, atomic, exactly like today's per-page writes), copies new hashed assets alongside old ones, updates the manifest, and runs all shared post-steps (sitemap shards, feed, redirects, data.json, image localization, changed-files report).

- Pros: uses only stable, documented framework contracts (`generateStaticParams`/`getStaticPaths` and the output directory layout). Survives framework version churn. The framework's own head handling, islands, RSC, and asset pipeline all work exactly as their docs say.
- Cons: each incremental run pays the framework's build startup cost (Astro: seconds; Next: tens of seconds). A webhook publish goes from ~5 seconds (owned) to roughly the framework's boot-plus-compile time. Still incomparably better than a full 1M-page rebuild, but it must be stated honestly.
- Verdict: the only maintainable integration for Next and Astro. Rendering their pages outside their builds is a support treadmill we refuse.

An honest side note for Next.js users: if a site is deployed on a Next server (not static export), Next's native ISR (`revalidatePath`, `revalidateTag`) already solves on-demand regeneration and hybld adds little. hybld's Next backend targets the `output: "export"` static-hosting case, where Next itself has no incremental story. The docs must say this plainly.

## 3. Architecture

### 3.1 RenderBackend contract

Extract today's `Renderer` behind an interface. Batch-oriented, because delegated backends render N pages in one framework build:

```ts
interface RenderBackend {
  name: string; // "react-vite" | "next" | "astro"

  /** Prepare build artifacts. Owned: vite client+ssr builds (with fingerprint reuse).
   *  Delegated: nothing up front (the framework build happens per batch). */
  prepare(opts: { clean: boolean }): Promise<{ assetGraphHash: string; assetFiles: string[] }>;

  /** Render a batch of resolved jobs.
   *  Owned: renders per page via the worker pool, returns HTML strings.
   *  Delegated: writes the scope file, runs the framework build, returns emitted file sets. */
  renderBatch(jobs: RenderJob[], opts: { noindex?: boolean }): Promise<RenderedPage[]>;

  close(): Promise<void>;
}

interface RenderJob {
  route: string;
  pageType: string;
  data: any; // prefetched by the engine; delegated pages may use it or fetch their own
}

type RenderedPage =
  | { route: string; kind: "html"; html: string }                 // owned: engine writes it
  | { route: string; kind: "files"; files: string[] }             // delegated: already on disk, merged by engine
  | { route: string; kind: "failed"; error: string };
```

### 3.2 What changes in the Builder

- `executeJob` splits into resolve (fetch data, compute contentHash, decide skip) and render (batched through the backend). Skip decisions stay in the engine and are identical across backends.
- Owned path: unchanged behavior; batch of size N renders N pages through the worker pool.
- Delegated path: all non-skipped jobs in a run form one batch = one framework build. Post-processing (data.json emission, image localization, noindex injection for previews) runs on the emitted HTML files, which works identically for both strategies since it is string/file manipulation.
- Asset handling: delegated backends report the framework's hashed asset dirs (`_next/static`, `_astro`) as the asset file list; the merge step copies them append-only; `assets gc` works unchanged. The asset graph hash comes from hashing that file list.
- Everything else (manifest, scope resolution, dependents, deletions, moves, sitemap, feed, redirects, report, lock, serve, sync, preview) is engine code and does not fork per backend.

### 3.3 Config surface

```ts
export default defineConfig({
  adapter: wordpress({ ... }),
  renderer: reactVite({ entry: "src/entry-server.tsx", workers: 4 }),  // default if omitted
  // or: renderer: next(),
  // or: renderer: astro(),
  pages: { ... },   // identical across backends
  ...
});
```

`render: { entry, template, workers }` stays supported as sugar for the react-vite backend (no breaking change for existing configs).

## 4. Per-framework design

### 4.1 React + Vite (`hybld` core, backend "react-vite")

Today's renderer moved behind the interface. No user-visible changes. All 44 existing tests must pass unmodified.

### 4.2 Next.js (`@hybld/next`)

User contract (App Router, `output: "export"`):

```ts
// app/articles/[slug]/page.tsx
import { hybldParams, hybldData } from "@hybld/next";

export async function generateStaticParams() {
  // Full catalog on a full build; only the scoped routes on incremental runs.
  return hybldParams("article", (a) => ({ slug: a.slug }));
}

export default async function Page({ params }) {
  const article = await hybldData("article", params.slug); // prefetched by the engine, no extra CMS call
  ...
}
```

Backend behavior per batch: write scope file, run `next build` (export mode) in a subprocess with `HYBLD_SCOPE` pointing at it, then merge `out/` into the cumulative output. `hybldParams` returns the full catalog when no scope file is present, so plain `next build` without hybld still works.

Constraints to document: export-mode limitations are Next's own (no server actions at runtime, image loader configuration required); head/meta via Next's `generateMetadata` as usual; per-run build cost is Next's compile time.

### 4.3 Astro (`@hybld/astro`)

User contract:

```astro
---
// src/pages/articles/[slug].astro
import { hybldPaths, hybldData } from "@hybld/astro";
export async function getStaticPaths() {
  return hybldPaths("article", (a) => ({ params: { slug: a.slug }, props: { article: a } }));
}
const { article } = Astro.props;
---
```

Backend behavior mirrors Next: scope file, `astro build` subprocess, merge `dist/` output. Astro's faster builds make it the better-behaved delegated backend.

Future fast path (explicitly deferred): Astro's Container API could enable an owned-style backend with per-page renders and no build startup. Revisit only after the delegated backend is proven; the Container API is still experimental.

## 5. Feature matrix

| Feature | react-vite | next | astro |
| --------- | ----------- | ------ | ------- |
| All build scopes, manifest, diffing, dependents, deletions, moves | yes | yes | yes |
| Sitemap, feed, redirects, changed-files, sync, assets gc | yes | yes | yes |
| data.json + image localization (HTML post-processing) | yes | yes | yes |
| Preview builds (noindex injected into emitted HTML) | yes | yes | yes |
| serve webhook + regen-on-miss | yes | yes (slower: framework build per regen) | yes |
| Per-page head injection by hybld | yes | no (Next generateMetadata owns it) | no (Astro head owns it) |
| Warm sub-second single-page rebuilds | yes | no (build startup per run) | no (build startup per run) |
| Vite plugin mode | yes | n/a | n/a |

## 6. Risks, stated honestly

1. **Webhook latency on delegated backends.** A publish rebuild costs one framework build startup. Mitigations: serve-mode queue already coalesces bursts; document expected latency; recommend cron batching for high-frequency sites.
2. **Double data fetching.** The engine fetches article metadata for diffing; the page may fetch again inside the framework build. Mitigated by the scope-file data handoff (`hybldData`) and the disk cache. Pages that fetch extra data (related posts) go through the CMS as usual.
3. **Framework contract drift.** We depend only on `generateStaticParams`/`getStaticPaths` semantics and output directory layouts. Both are stable public contracts; CI must pin and test against specific Next/Astro majors.
4. **Naming.** "hybld" implies Vite. Options: keep the name as a brand (Next uses Vite nowhere, Astro uses it internally), or rename before publishing. Decision needed before any npm publish, cheap now, expensive later.
5. **Scale behavior differs.** On delegated backends, a full 1M-page build through `next build`/`astro build` in one shot may hit framework memory limits; chunked builds (`--chunk`) become the required path at scale, which the engine already supports.

## 7. Phases

| Phase | Scope | Acceptance |
| ------- | ------- | ------------ |
| v0.4 | Extract `RenderBackend`; move current renderer behind it; `renderer:` config key; batch-oriented builder pipeline. No behavior change. | All 44 existing tests pass unchanged; demo e2e identical. |
| v0.5 | `@hybld/astro`: scope-file helper, delegated backend, example Astro site in `examples/astro-demo` against the same mock CMS; e2e of publish/edit/delete flows. | Astro demo passes the same publish/trash/rename scenarios as the React demo. |
| v0.6 | `@hybld/next`: same shape, `examples/next-demo`. | Next demo passes the same scenario suite (export mode). |
| v0.7 | Docs consolidation, naming decision, benchmark both delegated backends at 10k+ pages. | Documented latency numbers per backend. |

Astro before Next deliberately: faster builds make iteration cheaper, and its `getStaticPaths` props-passing gives the cleanest data handoff, so it derisks the delegated strategy before tackling Next's heavier build.

## 8. Open questions

- OQ-A: Package name at publish time (keep "hybld" as brand vs rename). Still open; decide before npm publish.
- OQ-B (resolved): `RenderBackend`, `RendererFactory`, and `delegatedRenderer` are public exports; third-party backends (Vue, Svelte, Solid) can be written today.
- OQ-C (resolved): previews are react-vite only; the delegated backends throw a clear error pointing at the framework's own draft mode.

## 9. Implementation notes (where reality diverged from the plan)

- Asset graph hash: source fingerprint for delegated backends, confirmed necessary (Next's buildId files change every run) and covered by a unit test. `recordAssetGraph` unions file lists per hash so per-run runtime chunks accumulate under one fingerprint.
- Multi-collection support shipped as a prerequisite: any page type with `collection: true` (plus the legacy "article" key) is adapter-backed, each with an optional per-collection adapter; targeted builds accept `type:value` syntax (`--ids author:5`).
- Merge policy for unscoped emissions: extras (static framework routes) merge with manifest rows, preserving existing page types; contentHash comes from the emitted HTML.
- Output paths are recorded from emitted files in delegated mode; Next requires `trailingSlash: true`, Astro works with both directory and file formats.
- Scope files are NDJSON; helpers fall back to full-catalog enumeration through the hybld config when no scope is present (plain builds, dev mode).
- Next RSC sidecars (`route/index.txt`) travel with their pages through merge, image localization, deletions, and moves (backends expose `pageSidecars`).
- Batch padding (unplanned, discovered in e2e): Next's static export refuses an empty `generateStaticParams`, so every delegated batch includes at least one page per dynamic route type, padded from the manifest, and all singleton pages (whose data must be present in every scope file the framework reads).
- Bundler battles (unplanned): framework helpers load `hybld/scope` via a `webpackIgnore` dynamic import so Next's bundler never processes the hybld graph; jiti is loaded lazily only in the config-loader fallback; Next projects must use a `.mjs` hybld config; Astro projects add the hybld packages to `vite.ssr.external`.
- Serve-mode regen on delegated backends returns 503 with Retry-After and rebuilds asynchronously instead of blocking the request on a framework build.
- Both Next routers are supported and demo-verified: App Router (`examples/next-demo`) and Pages Router (`examples/nextpages-demo`); the backend merges `_next/data/<buildId>/` JSON append-only so Pages Router client-side navigation reaches incrementally built pages.
