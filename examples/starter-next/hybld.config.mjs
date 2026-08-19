import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nextRenderer } from "@hybld/next/renderer";

// A LIVE public WordPress: WP Tavern (WordPress-news site, public REST API).
// Point CMS_URL at your own WordPress to make this starter yours.
// Courtesy: this is someone else's public server. The scripts use --limit 12
// and the polite rate settings below; do not run --all against the default
// source (it has ~6,600 posts). Full builds are for YOUR CMS_URL.
// Note: Next projects need a plain-JS config (.mjs), never .ts.
const CMS_URL = process.env.CMS_URL ?? "https://wptavern.com";

export default defineConfig({
  adapter: wordpress({
    baseUrl: CMS_URL,
    concurrency: 2,
    requestsPerSecond: 3,
  }),
  renderer: nextRenderer(),
  outDir: "site", // cumulative site; Next's own "out" is per-build staging

  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      data: (a) => ({
        title: a.title.rendered,
        html: a.content.rendered,
        excerpt: a.excerpt.rendered,
        date: a.date,
        sourceUrl: a.link, // credit the original article
      }),
      dependents: () => ["/"],
      match: (route) => {
        const m = route.match(/^\/articles\/([^/]+)\/$/);
        return m ? { slug: m[1] } : null;
      },
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({
        latest: (await cms.list({ perPage: 12 })).map((a) => ({
          slug: a.slug,
          title: a.title.rendered,
          date: a.date,
        })),
      }),
    },
  },

  // sitemap/feed off on purpose (demo indexes someone else's content);
  // enable them when CMS_URL is your own site.
});
