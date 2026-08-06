import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { contentful } from "../src/index.js";

const ENTRIES = Array.from({ length: 9 }, (_, i) => ({
  sys: { id: `cf-${i + 1}`, updatedAt: `2026-05-0${(i % 9) + 1}T00:00:00Z` },
  fields: { slug: `entry-${i + 1}`, title: `Entry ${i + 1}` },
}));

let server: Server;
let base: string;
let lastParams: URLSearchParams;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    lastParams = url.searchParams;
    const single = url.pathname.match(/\/entries\/(cf-\d+)$/);
    if (single) {
      const e = ENTRIES.find((x) => x.sys.id === single[1]);
      res.writeHead(e ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(e ?? {}));
      return;
    }
    let items = [...ENTRIES];
    const slug = url.searchParams.get("fields.slug");
    if (slug) items = items.filter((e) => e.fields.slug === slug);
    const after = url.searchParams.get("sys.updatedAt[gt]");
    if (after) {
      const since = new Date(after).getTime();
      items = items.filter((e) => new Date(e.sys.updatedAt).getTime() > since);
    }
    const skip = Number(url.searchParams.get("skip") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ total: items.length, skip, limit, items: items.slice(skip, skip + limit) }));
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

const adapter = () =>
  contentful({ space: "s1", accessToken: "tok", contentType: "article", host: `${base}` });

describe("contentful preset", () => {
  it("paginates with skip/limit and flattens sys+fields", async () => {
    const p1 = await adapter().listArticles({ page: 1, perPage: 4 });
    expect(p1.items).toHaveLength(4);
    expect(p1.items[0]).toMatchObject({ id: "cf-1", slug: "entry-1", modified: "2026-05-01T00:00:00Z" });
    expect(p1.hasMore).toBe(true);
    expect(lastParams.get("skip")).toBe("0");
    expect(lastParams.get("content_type")).toBe("article");
    const p3 = await adapter().listArticles({ page: 3, perPage: 4 });
    expect(p3.items).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
    expect(lastParams.get("skip")).toBe("8");
  });

  it("counts via body total", async () => {
    expect(await adapter().count()).toBe(9);
  });

  it("fetches by entry id and by slug field", async () => {
    expect((await adapter().getArticle({ id: "cf-3" })).slug).toBe("entry-3");
    expect((await adapter().getArticle({ slug: "entry-7" })).id).toBe("cf-7");
  });

  it("filters modified-since via sys.updatedAt", async () => {
    const res = await adapter().listModifiedSince!(new Date("2026-05-07T00:00:00Z"), { page: 1, perPage: 10 });
    expect(res.items.map((i: any) => i.id).sort()).toEqual(["cf-8", "cf-9"]);
  });
});
