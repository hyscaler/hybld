---
title: "React + Vite"
description: "Complete implementation guide for the owned renderer: project structure, entry files, hydration, SEO, previews, and production notes."
sidebar:
  order: 1
---
This is how you use hybld with a **plain React app**, no meta-framework required. It is the default backend and needs only the `hybld` package itself plus a CMS adapter (Next and Astro need their extra `@hybld/next` / `@hybld/astro` packages; React does not).

hybld runs the Vite client and SSR builds itself and renders every page through your entry-server module in a worker-thread pool. Warm single-page rebuilds take milliseconds. Working reference: `examples/demo-site`.

:::note[Which React setups does this cover?]
Any React app built with **Vite** (`@vitejs/plugin-react`), whether it started as a client-only SPA or already did SSR. hybld prerenders each page server-side, so you add a small server entry (below) even if your app was previously client-only; hydration then takes over in the browser.

If your React app is **not** on Vite (Create React App, a custom webpack setup, Parcel), the owned backend does not drive those bundlers. Your options: migrate the build to Vite (usually small for a CMS-backed content site), or, if you are on Next.js, use the [Next backend](/frameworks/nextjs/) instead, which is also React. There is no Create-React-App or bare-webpack backend.
:::

## Project structure

A complete hybld React + Vite project looks like this. Files marked NEW are what hybld adds to a standard Vite React app:

```
my-site/
  hybld.config.ts          NEW  content model, routes, dependents
  index.html                    + two placeholder comments
  vite.config.ts                unchanged
  package.json
  src/
    entry-client.tsx        NEW  hydration (replaces your old main.tsx)
    entry-server.tsx        NEW  the render function hybld calls per page
    pages/
      ArticlePage.tsx            your components, one per page type
      HomePage.tsx
      CategoryPage.tsx
      NotFoundPage.tsx
    pages.ts                NEW  pageType -> component map
  dist/                          cumulative static output (gitignore)
  .hybld/                        manifest + state (gitignore)
```

## Required wiring, all four files

### 1. `index.html`: two placeholders

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!--app-head-->
  </head>
  <body>
    <div id="root"><!--app-html--></div>
    <script type="module" src="/src/entry-client.tsx"></script>
  </body>
</html>
```

`<!--app-head-->` receives the per-page head fragment; `<!--app-html-->` receives the rendered body. Both are required; hybld errors at build time if either is missing.

### 2. `src/pages.ts`: the pageType map

One map connects config page types to components, used by both entries so server and client render identically:

```tsx
import { ArticlePage } from "./pages/ArticlePage";
import { HomePage } from "./pages/HomePage";
import { CategoryPage } from "./pages/CategoryPage";
import { NotFoundPage } from "./pages/NotFoundPage";

export const PAGES: Record<string, React.ComponentType<any>> = {
  article: ArticlePage,
  home: HomePage,
  category: CategoryPage,
  notFound: NotFoundPage,
};
```

### 3. `src/entry-server.tsx`: the render function

Default-export a function `({ route, pageType, data }) => { html, head }`. hybld calls it once per page, in a worker pool:

```tsx
import { renderToString } from "react-dom/server";
import { PAGES } from "./pages";

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export default function render({ route, pageType, data }: { route: string; pageType: string; data: any }) {
  const Page = PAGES[pageType];
  if (!Page) throw new Error(`No component registered for page type "${pageType}"`);

  const html = renderToString(<Page {...data} />);

  // The head fragment is where ALL SEO lives: title, description, canonical,
  // Open Graph, JSON-LD. Build it from `data`, the same data() your config produced.
  const head = [
    `<title>${esc(data.title ?? "My Site")}</title>`,
    `<meta name="description" content="${esc(data.excerpt ?? data.description ?? "")}">`,
    `<link rel="canonical" href="https://www.example.com${route}">`,
    `<meta property="og:title" content="${esc(data.title ?? "")}">`,
    `<meta property="og:type" content="${pageType === "article" ? "article" : "website"}">`,
  ].join("\n    ");

  return { html, head };
}
```

Returning a plain string instead of `{ html, head }` is allowed (the head stays empty). A render that throws fails that one page (recorded in the build summary); the rest of the batch continues.

### 4. `src/entry-client.tsx`: hydration

hybld injects each page's props as `window.__HYBLD_DATA__ = { route, pageType, data }` before `</body>`. Hydrate from it:

```tsx
import { hydrateRoot } from "react-dom/client";
import { PAGES } from "./pages";

declare global {
  interface Window { __HYBLD_DATA__?: { route: string; pageType: string; data: any } }
}

const payload = window.__HYBLD_DATA__;
if (payload) {
  const Page = PAGES[payload.pageType];
  hydrateRoot(document.getElementById("root")!, <Page {...payload.data} />);
}
```

Because the server rendered `<Page {...data} />` and the client hydrates `<Page {...payload.data} />` from the same serialized data, there is no hydration mismatch by construction. Keep components free of render-time randomness and browser-only APIs (guard `window` access behind `useEffect`).

That's the whole integration. `hybld build --all` now produces a fully prerendered, hydrated site.

## Page components: what they receive

Each component receives your config's `data()` result as props, nothing more:

```tsx
// src/pages/ArticlePage.tsx: props are exactly data(article) from hybld.config.ts
export function ArticlePage({ title, html, date, category }: {
  title: string; html: string; date: string; category: string;
}) {
  return (
    <article>
      <h1>{title}</h1>
      <p><time dateTime={date}>{date.slice(0, 10)}</time> · <a href={`/category/${category}/`}>{category}</a></p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
```

Internal navigation is plain `<a href>` between prerendered pages. If you want SPA-style client navigation, enable `emitData: true` in the config (a `data.json` next to every page) and fetch it on link clicks; the demo keeps things simple with full page loads.

## How builds work (and why they are fast)

- The Vite **client build** runs append-only into `outDir` (hashed assets accumulate; `--clean` empties it). The generated `index.html` becomes the per-page template and is moved out of `outDir` so the `/` route can own that path.
- The **SSR build** produces your entry bundle; pages render in `render.workers` worker threads (default 4), each with a per-page timeout (`render.timeout`, default 60s) so one hung render fails one page instead of the build.
- **Build reuse**: hybld fingerprints your sources (`src/`, `public/`, `index.html`, vite config, `.env*` files, lockfile, postcss/tailwind configs, hybld config, package.json). When nothing changed, repeat builds skip Vite entirely and reuse the cached template and SSR bundle, which is why warm CLI builds finish in tenths of a second. Reuse also verifies the hashed client assets still exist in `outDir`, so a wiped `dist` forces a real rebuild.
- **App code changes** produce a new asset graph; existing pages keep working against the old hashed assets and are re-rendered progressively via `hybld build --stale` (see [deployment](/operate/deployment/#app-code-deploys-code-staleness)).

At scale this backend is the fastest option by far: no framework build per batch, renders at worker-pool speed (thousands of pages per second for typical components), and warm single-page rebuilds in milliseconds. For very large catalogs read [Scaling](/operate/scaling/).

## Draft previews

`hybld preview --slugs my-draft` renders unpublished content (via the adapter's `getPreview`, e.g. WordPress `status=any` with auth) to `outDir/_preview/...` with a noindex meta tag, without touching the manifest, sitemap, or published pages. On this backend the preview is a normal hydrated page; the framework backends produce static snapshots instead. Wire it to a CMS "preview" button via `hybld serve`'s `POST /rebuild` or your own endpoint calling `builder.preview()`.

## Vite plugin mode (optional)

```ts
// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hybld } from "hybld/plugin";

export default defineConfig({ plugins: [react(), hybld()] });
```

Plain `vite build` then also prerenders the whole site (a forced full build, because Vite empties outDir first). Useful to keep a single build command in an existing pipeline; the CLI remains the primary interface for incremental work. hybld's own internal builds are recursion-guarded, and SSR passes in your own pipeline (`vite build --ssr`) are skipped so the prerender runs exactly once.

Passing a narrower scope (`hybld({ since: "last-build" })`) requires `build.emptyOutDir: false` in your Vite config; the plugin refuses to run otherwise, because an emptied outDir plus a narrow scope would leave the deployed site with only the scoped pages. Also note `vite build --watch` triggers a full forced prerender on every rebuild; prefer the CLI during development.

## Development workflow

hybld renders production builds; day-to-day component development stays pure Vite:

```bash
vite                                   # normal dev server for component work
hybld build --limit 20                 # spot-check real rendered output
hybld serve --static --regen           # serve dist/ locally with regen-on-miss
```

A practical pattern for content preview during development: run `hybld serve --static --regen` next to `vite`; the static server gives you real prerendered pages, and the regen flag rebuilds any article you navigate to that hasn't been built yet (resolved through your `match()` hook).

## Production notes for this backend

- Per-page head injection, hydration payloads, image localization, `emitData`, previews, and serve-mode inline regeneration all work here without caveats; this is the most fully-featured backend.
- The engine's `--concurrency` defaults to `render.workers`. Raising workers helps CPU-bound renders; the CMS fetch side is governed separately by `cms.concurrency`.
- `assets gc` scans `outDir/assets` and deletes hashed files no live page references (run it after `--stale` convergence).
- Keep `dist/` out of git; it is a build artifact that can always be reproduced from the manifest plus the CMS (or re-synced from your host).
