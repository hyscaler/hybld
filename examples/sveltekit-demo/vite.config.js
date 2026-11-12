import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      // adapter-static writes into `build`; hybld merges those pages into
      // its own cumulative outDir (`site`, see hybld.config.ts).
      adapter: adapter({ pages: "build", assets: "build" }),
      prerender: {
        // During hybld runs only the scoped pages may be built: the crawler
        // would follow links from the home page into the whole catalog.
        crawl: !process.env.HYBLD_INTERNAL,
      },
    }),
  ],
  // The hybld helper graph runs in Node at build time; keep it out of the
  // server bundle.
  ssr: { external: ["hybld", "@hybld/sveltekit", "@hybld/adapter-wordpress", "jiti"] },
});
