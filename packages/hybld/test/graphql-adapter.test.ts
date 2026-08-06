import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createGraphqlAdapter } from "../dist/index.js";

const POSTS = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, slug: `gql-${i + 1}` }));

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { query, variables } = JSON.parse(body);
      const respond = (data: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
      };
      if (query.includes("ListPosts")) {
        const { page, perPage } = variables;
        respond({ posts: POSTS.slice((page - 1) * perPage, page * perPage) });
      } else if (query.includes("GetPost")) {
        respond({ post: POSTS.find((p) => p.slug === variables.slug || p.id === variables.id) ?? null });
      } else if (query.includes("Broken")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: [{ message: "boom" }] }));
      } else {
        respond({});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

function adapter() {
  return createGraphqlAdapter({
    endpoint: base,
    list: { query: "query ListPosts($page: Int, $perPage: Int) { posts }", pick: (d: any) => d.posts },
    item: { query: "query GetPost($id: ID, $slug: String) { post }", pick: (d: any) => d.post },
    count: { query: "query CountPosts { total }", pick: () => POSTS.length },
  });
}

describe("createGraphqlAdapter", () => {
  it("lists with pagination variables", async () => {
    const a = adapter();
    const p1 = await a.listArticles({ page: 1, perPage: 5 });
    expect(p1.items).toHaveLength(5);
    expect(p1.hasMore).toBe(true);
    const p3 = await a.listArticles({ page: 3, perPage: 5 });
    expect(p3.items).toHaveLength(2);
    expect(p3.hasMore).toBe(false);
  });

  it("fetches a single item by slug", async () => {
    expect(((await adapter().getArticle({ slug: "gql-3" })) as any).id).toBe(3);
  });

  it("surfaces GraphQL errors", async () => {
    const a = createGraphqlAdapter({
      endpoint: base,
      list: { query: "query Broken { x }", pick: (d: any) => d.x },
      item: { query: "query GetPost { post }", pick: (d: any) => d.post },
    });
    await expect(a.listArticles({ page: 1, perPage: 5 })).rejects.toThrow("boom");
  });

  it("has no listModifiedSince unless configured", () => {
    expect(adapter().listModifiedSince).toBeUndefined();
  });
});
