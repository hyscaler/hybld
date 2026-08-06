// Plain .mjs on purpose: with the Next backend this config is also loaded
// inside Next's build workers (helper fallback mode), where TypeScript
// configs cannot be imported reliably. Keep Next projects' hybld config JS.
import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nextRenderer } from "@hybld/next/renderer";

const CMS_URL = process.env.CMS_URL ?? "http://localhost:4399";

const listItem = (a) => ({
  slug: a.slug,
  title: a.title.rendered,
  date: a.date,
  category: a.category_slug,
});

export default defineConfig({
  adapter: wordpress({ baseUrl: CMS_URL, trackDeletes: true }),
  renderer: nextRenderer(),
  outDir: "site",
  manifest: ".hybld/manifest.db",
  pages: {
    article: {
      route: (a) => `/articles/${a.slug}/`,
      match: (route) => {
        const m = route.match(/^\/articles\/([^/]+)\/$/);
        return m ? { slug: m[1] } : null;
      },
      data: (a) => ({
        title: a.title.rendered,
        html: a.content.rendered,
        excerpt: a.excerpt?.rendered ?? "",
        date: a.date,
        category: a.category_slug,
        slug: a.slug,
      }),
      dependents: (a) => ["/", { type: "category", id: a.category_slug, depth: 1 }],
    },
    home: {
      route: () => "/",
      data: async ({ cms }) => ({
        latest: (await cms.list({ perPage: 10 })).map(listItem),
      }),
    },
    category: {
      enumerate: async ({ cms }) => cms.listTerms("category"),
      route: (c) => `/category/${c.slug}/`,
      data: async (c, _page, { cms }) => ({
        name: c.name,
        slug: c.slug,
        items: (await cms.list({ perPage: 20, category_slug: c.slug })).map(listItem),
      }),
    },
  },
  sitemap: { enabled: true, baseUrl: "https://next-demo.example.com" },
});
