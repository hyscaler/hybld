import { delegatedRenderer, type RendererFactory } from "hybld";

export interface NuxtRendererOptions {
  /** Where `nuxi generate` writes the static site (relative to root). Default ".output/public". */
  nuxtOutDir?: string;
  /** Build command. Default ["npx", "nuxi", "generate"]. */
  buildCommand?: string[];
  /** Source inputs for the fingerprint. */
  sourceDirs?: string[];
  /** app.buildAssetsDir, when changed from the default "/_nuxt/". */
  buildAssetsDir?: string;
}

/**
 * Nuxt render backend (delegated strategy) for statically generated sites.
 * hybld computes the scope, then `nuxi generate` prerenders it; the
 * "@hybld/nuxt" module (add it to `modules`) feeds the scoped routes to the
 * prerenderer. Pages read their data with useHybldData().
 * Import this only in hybld.config, never in app code.
 */
export function nuxtRenderer(opts: NuxtRendererOptions = {}): RendererFactory {
  const assets = (opts.buildAssetsDir ?? "_nuxt").replace(/^\/+|\/+$/g, "");
  return delegatedRenderer({
    name: "nuxt",
    buildCommand: opts.buildCommand ?? ["npx", "nuxi", "generate"],
    frameworkOutDir: opts.nuxtOutDir ?? ".output/public",
    sourceDirs: opts.sourceDirs ?? [
      "app",
      "pages",
      "components",
      "layouts",
      "composables",
      "middleware",
      "plugins",
      "server",
      "shared",
      "assets",
      "public",
      "app.vue",
      "nuxt.config.ts",
      "nuxt.config.js",
      "nuxt.config.mjs",
      "package.json",
    ],
    assetDirs: [assets],
    env: { NUXT_TELEMETRY_DISABLED: "1" },
    pageFileCandidates: (route) => {
      if (route === "/") return ["index.html"];
      const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
      return [`${trimmed}/index.html`, `${trimmed}.html`];
    },
    // The extracted payload client-side navigation reads instead of running
    // the page's data loaders in the browser.
    sidecarsFor: (primary) => [
      primary === "index.html" ? "_payload.json" : "",
      primary.endsWith("/index.html") ? `${primary.slice(0, -"index.html".length)}_payload.json` : "",
      primary.endsWith(".html") && !primary.endsWith("index.html") ? `${primary.slice(0, -".html".length)}/_payload.json` : "",
    ].filter(Boolean),
  });
}
