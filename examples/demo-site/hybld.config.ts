import { defineConfig } from "hybld";
import { wordpress } from "@hybld/adapter-wordpress";

const CMS_URL = process.env.CMS_URL ?? "http://localhost:4399";
const SITE_URL = "https://demo.example.com";

const listItem = (a: any) => ({
  slug: a.slug,
  title: a.title.rendered,
  date: a.date,
  category: a.category_slug,
});

export default defineConfig({
  adapter: wordpress({ baseUrl: CMS_URL, trackDeletes: true }),
  outDir: "dist",
  manifest: ".hybld/manifest.db",
  render: {
    entry: "src/entry-server.tsx",
    workers: 4,
  },
  cms: {
    concurrency: 4,
    perPage: 20,
    // cache: { ttlSeconds: 300 },  // opt-in disk cache: good for bulk full/chunked
    // rebuilds, but it trades freshness, so keep it off for webhook-driven sites.
  },
  emitData: true,
  feed: {
    enabled: true,
    title: "Hybld Demo",
    description: "Latest articles from the hybld demo site",
    limit: 15,
  },
  images: {
    origins: [CMS_URL],
  },
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
      dependents: (a: any) => ["/", { type: "category", id: a.category_slug, depth: 2 }],
    },
    home: {
      route: () => "/",
      data: async ({ cms }: any) => ({
        latest: (await cms.list({ perPage: 10 })).map(listItem),
      }),
    },
    category: {
      enumerate: async ({ cms }: any) => cms.listTerms("category"),
      paginate: { perPage: 8 },
      route: (c: any, page: number) => (page > 1 ? `/category/${c.slug}/page/${page}/` : `/category/${c.slug}/`),
      data: async (c: any, page: number, { cms }: any) => {
        const totalPages = Math.max(1, Math.ceil(c.count / 8));
        return {
          name: c.name,
          slug: c.slug,
          page,
          totalPages,
          items: (await cms.list({ page, perPage: 8, category_slug: c.slug })).map(listItem),
        };
      },
    },
    notFound: {
      route: () => "/404.html",
      data: () => ({}),
    },
  },
  sitemap: { enabled: true, baseUrl: SITE_URL },
});
