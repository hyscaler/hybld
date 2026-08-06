import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createFetcher } from "../dist/index.js";

let server: Server;
let base: string;
let hits: Record<string, number> = {};
let failFirst = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    hits[url] = (hits[url] ?? 0) + 1;
    if (url === "/flaky" && hits[url] <= failFirst) {
      res.writeHead(429, { "retry-after": "0" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url, hit: hits[url] }));
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server.close());

describe("createFetcher", () => {
  it("retries on 429 honoring Retry-After", async () => {
    hits = {};
    failFirst = 2;
    const fetcher = createFetcher({ memoize: false });
    const res = await fetcher(`${base}/flaky`);
    expect(res.status).toBe(200);
    expect(hits["/flaky"]).toBe(3); // two 429s + one success
  });

  it("memoizes identical GETs within a run and clears on demand", async () => {
    hits = {};
    const fetcher = createFetcher();
    const a = await (await fetcher(`${base}/memo`)).json();
    const b = await (await fetcher(`${base}/memo`)).json();
    expect(hits["/memo"]).toBe(1);
    expect(a.hit).toBe(1);
    expect(b.hit).toBe(1);

    fetcher.clearMemo();
    const c = await (await fetcher(`${base}/memo`)).json();
    expect(hits["/memo"]).toBe(2);
    expect(c.hit).toBe(2);
  });

  it("counts requests across retries", async () => {
    hits = {};
    failFirst = 1;
    const fetcher = createFetcher({ memoize: false });
    await fetcher(`${base}/flaky`);
    expect(fetcher.requestCount()).toBe(2);
  });
});
