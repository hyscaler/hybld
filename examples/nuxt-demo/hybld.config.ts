import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";
import { nuxtRenderer } from "@hybld/nuxt/renderer";

const CMS_URL = process.env.CMS_URL ?? "http://localhost:4399";

const listItem = (a: any) => ({
  slug: a.slug,
  title: a.title.rendered,
  date: a.date,
  category: a.category_slug,
});

export default defineConfig({
  adapter: wordpress({ baseUrl: CMS_URL, trackDeletes: true }),
  renderer: nuxtRenderer(),
  outDir: "site",
  manifest: ".hybld/manifest.db",
  pages: {
    article: {
      route: (a: any) => `/articles/${a.slug}/`,
      match: (route: string) => {
        const m = route.match(/^\/articles\/([^/]+)\/$/);
        return m ? { slug: m[1] } : null;
      },
      data: (a: any) => ({
        title: a.title.rendered,
        html: a.content.rendered,
        excerpt: a.excerpt?.rendered ?? "",
        date: a.date,
        category: a.category_slug,
        slug: a.slug,
      }),
      dependents: (a: any) => ["/", { type: "category", id: a.category_slug, depth: 1 }],
    },
    home: {
      route: () => "/",
      data: async ({ cms }: any) => ({
        latest: (await cms.list({ perPage: 10 })).map(listItem),
      }),
    },
    category: {
      enumerate: async ({ cms }: any) => cms.listTerms("category"),
      route: (c: any) => `/category/${c.slug}/`,
      data: async (c: any, _page: number, { cms }: any) => ({
        name: c.name,
        slug: c.slug,
        items: (await cms.list({ perPage: 20, category_slug: c.slug })).map(listItem),
      }),
    },
  },
  sitemap: { enabled: true, baseUrl: "https://nuxt-demo.example.com" },
  feed: { enabled: true, title: "Nuxt Demo", description: "hybld on Nuxt" },
});
