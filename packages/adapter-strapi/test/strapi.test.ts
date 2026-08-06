import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { strapi } from "../src/index.js";

// Strapi v4-shaped mock: data[].attributes + meta.pagination.
const ENTRIES = Array.from({ length: 7 }, (_, i) => ({
  id: i + 1,
  attributes: {
    slug: `strapi-${i + 1}`,
    title: `Strapi ${i + 1}`,
    updatedAt: `2026-06-0${(i % 7) + 1}T00:00:00.000Z`,
  },
}));

let server: Server;
let base: string;
let lastUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    lastUrl = url.toString();
    const respond = (data: any[], total: number) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data, meta: { pagination: { total } } }));
    };
    const idMatch = url.pathname.match(/^\/api\/articles\/(\d+)$/);
    if (idMatch) {
      const e = ENTRIES.find((x) => x.id === Number(idMatch[1]));
      res.writeHead(e ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: e ?? null }));
      return;
    }
    let items = [...ENTRIES];
    const slug = url.searchParams.get("filters[slug][$eq]");
    if (slug) items = items.filter((e) => e.attributes.slug === slug);
    const after = url.searchParams.get("filters[updatedAt][$gt]");
    if (after) items = items.filter((e) => e.attributes.updatedAt > after);
    const page = Number(url.searchParams.get("pagination[page]") ?? 1);
    const size = Number(url.searchParams.get("pagination[pageSize]") ?? 25);
    respond(items.slice((page - 1) * size, page * size), items.length);
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

const adapter = () => strapi({ baseUrl: base, contentType: "articles" });

describe("strapi preset", () => {
  it("lists with Strapi pagination params and flattens attributes", async () => {
    const p1 = await adapter().listArticles({ page: 1, perPage: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.items[0].slug).toBe("strapi-1");
    expect(p1.items[0].modified).toBe("2026-06-01T00:00:00.000Z");
    expect(p1.hasMore).toBe(true);
    const p3 = await adapter().listArticles({ page: 3, perPage: 3 });
    expect(p3.items).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
  });

  it("counts via meta.pagination.total", async () => {
    expect(await adapter().count()).toBe(7);
  });

  it("fetches by id and by slug filter", async () => {
    expect((await adapter().getArticle({ id: 4 })).slug).toBe("strapi-4");
    expect((await adapter().getArticle({ slug: "strapi-6" })).id).toBe(6);
  });

  it("implements listModifiedSince via updatedAt filter", async () => {
    const a = adapter();
    expect(a.listModifiedSince).toBeDefined();
    const res = await a.listModifiedSince!(new Date("2026-06-05T00:00:00Z"), { page: 1, perPage: 10 });
    expect(res.items.map((i: any) => i.slug).sort()).toEqual(["strapi-6", "strapi-7"]);
    expect(lastUrl).toContain("filters%5BupdatedAt%5D%5B%24gt%5D=2026-06-05");
  });
});
