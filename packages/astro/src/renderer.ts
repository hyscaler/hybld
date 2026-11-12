import { delegatedRenderer, type RendererFactory } from "hybld";

export interface AstroRendererOptions {
  /** Astro's outDir (relative to root). Must differ from hybld's outDir. Default "dist". */
  astroOutDir?: string;
  /** Build command. Default ["npx", "astro", "build"]. */
  buildCommand?: string[];
  /** Extra source dirs for the fingerprint. Default src, public, astro.config.*. */
  sourceDirs?: string[];
}

/**
 * Astro render backend (delegated strategy): hybld computes the scope, then
 * `astro build` renders it. Dynamic routes opt in via hybldPaths() in their
 * getStaticPaths; static routes rebuild every run and merge as extras.
 * Import this only in hybld.config.ts, never in page code.
 */
export function astroRenderer(opts: AstroRendererOptions = {}): RendererFactory {
  return delegatedRenderer({
    name: "astro",
    buildCommand: opts.buildCommand ?? ["npx", "astro", "build"],
    frameworkOutDir: opts.astroOutDir ?? "dist",
    sourceDirs: opts.sourceDirs ?? ["src", "public", "astro.config.mjs", "astro.config.ts", "package.json"],
    assetDirs: ["_astro"],
    // Astro has no client router by default; islands and scripts work at any URL.
    previewScripts: "keep",
    pageFileCandidates: (route) => {
      if (route === "/") return ["index.html"];
      const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
      // build.format "directory" (Astro default) and "file" layouts.
      return [`${trimmed}/index.html`, `${trimmed}.html`];
    },
  });
}
