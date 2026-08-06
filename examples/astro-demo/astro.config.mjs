import { defineConfig } from "astro/config";

// Astro builds into its default `dist`; hybld merges those pages into its
// own cumulative outDir (`site`, see hybld.config.ts).
export default defineConfig({
  vite: {
    // Keep the hybld helper graph external to the SSR bundle; it runs in
    // Node at build time and must not be bundled by Rollup.
    ssr: { external: ["hybld", "@hybld/astro", "@hybld/adapter-wordpress", "jiti"] },
  },
});
