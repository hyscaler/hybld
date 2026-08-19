import { defineConfig } from "astro/config";

export default defineConfig({
  vite: {
    // REQUIRED: keep the hybld helper graph (and the adapter) out of Astro's SSR bundle.
    ssr: { external: ["hybld", "@hybld/astro", "@hybld/adapter-wordpress", "jiti"] },
  },
});
