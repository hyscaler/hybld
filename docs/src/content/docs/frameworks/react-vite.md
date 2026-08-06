---
title: "React + Vite"
description: "The owned renderer for plain React apps: entry files, hydration, build reuse, Vite plugin mode, and previews."
sidebar:
  order: 1
---
This is how you use hybld with a **plain React app**, no meta-framework required. It is the default backend and needs only the `hybld` package itself plus a CMS adapter (Next and Astro need their extra `@hybld/next` / `@hybld/astro` packages; React does not).

hybld runs the Vite client and SSR builds itself and renders every page through your entry-server module in a worker-thread pool. Warm single-page rebuilds take milliseconds. Working reference: `examples/demo-site`.

:::note[Which React setups does this cover?]
Any React app built with **Vite** (`@vitejs/plugin-react`), whether it started as a client-only SPA or already did SSR. hybld prerenders each page server-side, so you add a small server entry (below) even if your app was previously client-only; hydration then takes over in the browser.

If your React app is **not** on Vite (Create React App, a custom webpack setup, Parcel), the owned backend does not drive those bundlers. Your options: migrate the build to Vite (usually small for a CMS-backed content site), or, if you are on Next.js, use the [Next backend](/frameworks/nextjs/) instead, which is also React. There is no Create-React-App or bare-webpack backend.
:::

## Required wiring

### 1. index.html placeholders

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <!--app-head-->
  </head>
  <body>
    <div id="root"><!--app-html--></div>
    <script type="module" src="/src/entry-client.tsx"></script>
  </body>
</html>
```

`<!--app-head-->` receives the per-page head fragment; `<!--app-html-->` receives the rendered body. Both are required (hybld errors if missing).

### 2. Server entry (`render.entry`, default `src/entry-server.tsx`)

Default-export a render function returning `{ html, head }`:

```tsx
import { renderToString } from "react-dom/server";
import { PAGES } from "./pages";   // { article: ArticlePage, home: HomePage, ... }

export default function render({ route, pageType, data }) {
  const Page = PAGES[pageType];
  const html = renderToString(<Page {...data} />);
  const head = [
    `<title>${escapeHtml(data.title ?? "My Site")}</title>`,
    `<meta name="description" content="${escapeHtml(data.excerpt ?? "")}">`,
    `<link rel="canonical" href="https://www.example.com${route}">`,
  ].join("\n    ");
  return { html, head };
}
```

The head fragment is where SEO lives: title, description, canonical, Open Graph, JSON-LD. Returning a plain string instead of `{ html, head }` is allowed (head stays empty).

### 3. Client entry (hydration)

hybld injects the page's props as `window.__HYBLD_DATA__ = { route, pageType, data }` before `</body>`:

```tsx
import { hydrateRoot } from "react-dom/client";
import { PAGES } from "./pages";

const payload = window.__HYBLD_DATA__;
if (payload) {
  const Page = PAGES[payload.pageType];
  hydrateRoot(document.getElementById("root")!, <Page {...payload.data} />);
}
```

## How builds work

- The Vite client build runs append-only into `outDir` (assets accumulate; `--clean` empties it). The generated `index.html` becomes the per-page template and is moved out of `outDir` so the `/` route can own that path.
- The SSR build produces your entry bundle; pages render in `render.workers` worker threads.
- **Build reuse**: hybld fingerprints your sources (`src/`, `public/`, `index.html`, vite config, `.env*` files, lockfile, postcss/tailwind configs, hybld config, package.json). When nothing changed, repeat builds skip Vite entirely and reuse the cached template and SSR bundle, which is why warm CLI builds finish in tenths of a second. Reuse also verifies the hashed client assets still exist in `outDir`, so a wiped `dist` forces a real rebuild.

## Vite plugin mode (optional)

```ts
// vite.config.ts
import { hybld } from "hybld/plugin";
export default defineConfig({ plugins: [react(), hybld()] });
```

Plain `vite build` then also prerenders the whole site (a forced full build, because Vite empties outDir first). hybld's own internal builds are recursion-guarded, and SSR passes in your own pipeline (`vite build --ssr`) are skipped so the prerender runs exactly once, after the client build.

Passing a narrower scope (`hybld({ since: "last-build" })`) requires `build.emptyOutDir: false` in your Vite config; the plugin refuses to run otherwise, because an emptied outDir plus a narrow scope would leave the deployed site with only the scoped pages. Also note `vite build --watch` triggers a full forced prerender on every rebuild; prefer the CLI during development.

## Previews

`hybld preview --slugs my-draft` renders unpublished content (adapter `getPreview`) to `outDir/_preview/...` with a noindex meta tag, without touching the manifest or sitemap. Owned-backend exclusive.

## Backend-specific notes

- Per-page head injection, hydration payloads, image localization, `emitData`, and serve-mode inline regeneration all work here without caveats.
- `assets gc` scans `outDir/assets`.
- The engine's `--concurrency` defaults to `render.workers`.
