import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createRestAdapter } from "../dist/index.js";

const ARTICLES = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  slug: `post-${i + 1}`,
  modified: `2026-06-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`,
}));

let server: Server;
let base: string;
let seenParams: URLSearchParams | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    seenParams = url.searchParams;
    if (url.pathname.match(/^\/items\/\d+$/)) {
      const id = Number(url.pathname.split("/").pop());
      const item = ARTICLES.find((a) => a.id === id);
      res.writeHead(item ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(item ?? {}));
      return;
    }
    let items = [...ARTICLES];
    const slug = url.searchParams.get("slug");
    if (slug) items = items.filter((a) => a.slug === slug);
    const after = url.searchParams.get("changed_since");
    if (after) items = items.filter((a) => a.modified > after);
    const page = Number(url.searchParams.get("p") ?? 1);
    const perPage = Number(url.searchParams.get("pp") ?? 10);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    res.writeHead(200, { "content-type": "application/json", "x-total": String(items.length) });
    res.end(JSON.stringify(slice));
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

function adapter() {
  return createRestAdapter({
    listUrl: `${base}/items`,
    pageParam: "p",
    perPageParam: "pp",
    modifiedAfterParam: "changed_since",
    count: { header: "x-total" },
  });
}

describe("createRestAdapter", () => {
  it("paginates with hasMore from the count header", async () => {
    const a = adapter();
    const p1 = await a.listArticles({ page: 1, perPage: 10 });
    expect(p1.items).toHaveLength(10);
    expect(p1.hasMore).toBe(true);
    const p3 = await a.listArticles({ page: 3, perPage: 10 });
    expect(p3.items).toHaveLength(5);
    expect(p3.hasMore).toBe(false);
  });

  it("counts via the header", async () => {
    expect(await adapter().count()).toBe(25);
  });

  it("fetches items by id and by slug (array pick)", async () => {
    const a = adapter();
    expect(((await a.getArticle({ id: 7 })) as any).slug).toBe("post-7");
    expect(((await a.getArticle({ slug: "post-9" })) as any).id).toBe(9);
    expect(await a.getArticle({ id: 999 })).toBeNull();
  });

  it("exposes listModifiedSince only when the param is configured, and passes it through", async () => {
    const a = adapter();
    expect(a.listModifiedSince).toBeDefined();
    await a.listModifiedSince!(new Date("2026-06-20T00:00:00Z"), { page: 1, perPage: 10 });
    expect(seenParams?.get("changed_since")).toBe("2026-06-20T00:00:00.000Z");

    const noSince = createRestAdapter({ listUrl: `${base}/items` });
    expect(noSince.listModifiedSince).toBeUndefined();
  });

  it("passes extra list filters through as query params", async () => {
    const a = adapter();
    await a.listArticles({ page: 1, perPage: 5, category: "tech" });
    expect(seenParams?.get("category")).toBe("tech");
  });
});
