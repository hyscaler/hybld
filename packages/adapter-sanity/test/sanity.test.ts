import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { sanity } from "../src/index.js";

const DOCS = Array.from({ length: 6 }, (_, i) => ({
  _id: `doc-${i + 1}`,
  _type: "post",
  _updatedAt: `2026-04-0${i + 1}T00:00:00Z`,
  slug: { current: `post-${i + 1}` },
  title: `Post ${i + 1}`,
}));

let server: Server;
let base: string;

// Minimal GROQ evaluator for exactly the query shapes the preset issues.
beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const query = url.searchParams.get("query") ?? "";
    const param = (name: string) => {
      const raw = url.searchParams.get(`$${name}`);
      return raw ? JSON.parse(raw) : undefined;
    };
    let result: unknown = null;
    if (query.startsWith("count(")) {
      result = DOCS.length;
    } else if (query.includes("_id == $id")) {
      result = DOCS.find((d) => d._id === param("id")) ?? null;
    } else if (query.includes("slug.current == $slug")) {
      result = DOCS.find((d) => d.slug.current === param("slug")) ?? null;
    } else {
      let docs = [...DOCS].sort((a, b) => (a._id < b._id ? -1 : 1));
      if (query.includes("_updatedAt > $since")) {
        const since = new Date(param("since")).getTime();
        docs = docs.filter((d) => new Date(d._updatedAt).getTime() > since);
      }
      const start = param("start") ?? 0;
      const end = param("end") ?? docs.length;
      result = docs.slice(start, end);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result }));
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

const adapter = () => sanity({ projectId: "p", dataset: "production", type: "post", baseUrl: base });

describe("sanity preset", () => {
  it("lists with GROQ slices and normalizes documents", async () => {
    const p1 = await adapter().listArticles({ page: 1, perPage: 4 });
    expect(p1.items).toHaveLength(4);
    expect(p1.items[0]).toMatchObject({ id: "doc-1", slug: "post-1", modified: "2026-04-01T00:00:00Z" });
    expect(p1.hasMore).toBe(true);
    const p2 = await adapter().listArticles({ page: 2, perPage: 4 });
    expect(p2.items).toHaveLength(2);
    expect(p2.hasMore).toBe(false);
  });

  it("counts documents", async () => {
    expect(await adapter().count()).toBe(6);
  });

  it("fetches by _id and by slug.current", async () => {
    expect((await adapter().getArticle({ id: "doc-2" })).slug).toBe("post-2");
    expect((await adapter().getArticle({ slug: "post-5" })).id).toBe("doc-5");
    expect(await adapter().getArticle({ slug: "nope" })).toBeNull();
  });

  it("filters modified-since via _updatedAt", async () => {
    const res = await adapter().listModifiedSince!(new Date("2026-04-04T00:00:00Z"), { page: 1, perPage: 10 });
    expect(res.items.map((i: any) => i.id)).toEqual(["doc-5", "doc-6"]);
  });
});
