import { resolve, sep } from "node:path";
import type { Plugin } from "vite";
import type { BuildOptions } from "./types.js";

export interface HybldPluginOptions extends BuildOptions {
  /** Path to hybld.config.ts. Default: auto-discovered from the Vite root. */
  configFile?: string;
}

/**
 * Experimental Vite plugin mode: `vite build` runs the client build as usual,
 * then hybld prerenders in the same output directory. Because Vite empties
 * the outDir at the start of its build, the default scope is a forced full
 * build; pass a narrower BuildOptions scope only if you also set
 * `build.emptyOutDir: false` in your Vite config.
 */
export function hybld(options: HybldPluginOptions = {}): Plugin {
  let root = process.cwd();
  let isSsrBuild = false;
  let emptiesOutDir = true;
  return {
    name: "hybld",
    apply: "build",
    configResolved(config) {
      root = config.root;
      // The prerender must run once, after the CLIENT build; an SSR pass in
      // the user's own pipeline would otherwise trigger a second full run.
      isSsrBuild = Boolean(config.build.ssr);
      // Vite's default (null) empties outDir only when it is inside the root
      // (outside, Vite just warns); an explicit true always empties.
      const outDir = resolve(config.root, config.build.outDir);
      const insideRoot = outDir === config.root || outDir.startsWith(config.root + sep);
      emptiesOutDir =
        config.build.emptyOutDir === true || (config.build.emptyOutDir !== false && insideRoot);
    },
    async closeBundle() {
      // hybld's own internal Vite builds must not re-trigger the plugin.
      if (process.env.HYBLD_INTERNAL) return;
      if (isSsrBuild) return;
      const { configFile, ...scope } = options;
      // Narrow scopes + an emptied outDir would silently drop every page
      // outside the scope from the deployed site. Refuse, loudly.
      if (Object.keys(scope).length > 0 && emptiesOutDir) {
        throw new Error(
          "hybld plugin: a narrow build scope was configured but Vite empties outDir at build start, " +
            "which would leave the site with only the scoped pages. Set build.emptyOutDir: false in your " +
            "Vite config, or remove the scope to use the default full rebuild."
        );
      }
      const { createBuilder } = await import("./builder.js");
      const builder = await createBuilder({ configFile, cwd: root, externalClientBuild: true });
      try {
        const opts: BuildOptions = Object.keys(scope).length > 0 ? scope : { all: true, force: true };
        const summary = await builder.build(opts);
        console.log(
          `[hybld] prerendered ${summary.built.length} page(s), skipped ${summary.skipped.length}, failed ${summary.failed.length}`
        );
        if (summary.failed.length > 0) {
          for (const f of summary.failed) console.error(`[hybld] FAILED ${f.route}: ${f.error}`);
          throw new Error(`hybld: ${summary.failed.length} page(s) failed to prerender`);
        }
      } finally {
        await builder.close();
      }
    },
  };
}
