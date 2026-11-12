import { delegatedRenderer, type RendererFactory } from "hybld";

export interface SvelteKitRendererOptions {
  /** adapter-static's output dir (relative to root). Must differ from hybld's outDir. Default "build". */
  kitOutDir?: string;
  /** Build command. Default ["npx", "vite", "build"]. */
  buildCommand?: string[];
  /** Source inputs for the fingerprint. Default src, static, svelte.config.js, vite.config.*, package.json. */
  sourceDirs?: string[];
  /** kit.appDir, when changed from the default "_app". */
  appDir?: string;
}

/**
 * SvelteKit render backend (delegated strategy) for sites prerendered with
 * adapter-static. hybld computes the scope, then `vite build` prerenders it.
 * Dynamic routes opt in through hybldEntries() in their `entries` export;
 * static routes rebuild every run and merge as extras. Requires
 * `trailingSlash = "always"` so pages are emitted as route/index.html, and
 * `kit.prerender.crawl` switched off during hybld runs so the crawler does
 * not pull unscoped pages into the build.
 * Import this only in hybld.config, never in route code.
 */
export function sveltekitRenderer(opts: SvelteKitRendererOptions = {}): RendererFactory {
  const appDir = (opts.appDir ?? "_app").replace(/^\/+|\/+$/g, "");
  return delegatedRenderer({
    name: "sveltekit",
    buildCommand: opts.buildCommand ?? ["npx", "vite", "build"],
    frameworkOutDir: opts.kitOutDir ?? "build",
    sourceDirs: opts.sourceDirs ?? [
      "src",
      "static",
      "svelte.config.js",
      "vite.config.js",
      "vite.config.ts",
      "package.json",
    ],
    // Content-hashed client chunks. The rest of appDir (version.json, env.js)
    // is unhashed and overwrite-copied as static files.
    assetDirs: [`${appDir}/immutable`],
    pageFileCandidates: (route) => {
      if (route === "/") return ["index.html"];
      const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
      return [`${trimmed}/index.html`, `${trimmed}.html`];
    },
    // Server load output for client-side navigation, emitted next to each page.
    sidecarsFor: (primary) => [
      primary === "index.html" ? "__data.json" : "",
      primary.endsWith("/index.html") ? `${primary.slice(0, -"index.html".length)}__data.json` : "",
      primary.endsWith(".html") && !primary.endsWith("index.html") ? `${primary.slice(0, -".html".length)}/__data.json` : "",
    ].filter(Boolean),
  });
}
