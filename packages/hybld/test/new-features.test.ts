import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFetcher,
  Manifest,
  OutputWriter,
  writeFeed,
  syncOutput,
  pushManifest,
  pullManifest,
  type ManifestRow,
} from "../dist/index.js";

let server: Server;
let base: string;
let hits: Record<string, number> = {};
let putBodies: Record<string, Buffer> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        putBodies[url] = Buffer.concat(chunks);
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (url.startsWith("/stored")) {
      res.writeHead(putBodies[url] ? 200 : 404);
      res.end(putBodies[url] ?? "");
      return;
    }
    hits[url] = (hits[url] ?? 0) + 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url, hit: hits[url] }));
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

describe("disk response cache", () => {
  it("serves repeat GETs from disk across memo clears, within TTL", async () => {
    hits = {};
    const dir = mkdtempSync(join(tmpdir(), "hybld-cache-"));
    const fetcher = createFetcher({});
    fetcher.enableDiskCache({ dir, ttlMs: 60_000 });
    await (await fetcher(`${base}/cacheme`)).json();
    fetcher.clearMemo(); // simulates a new build run
    const second = await (await fetcher(`${base}/cacheme`)).json();
    expect(hits["/cacheme"]).toBe(1); // second response came from disk
    expect(second.hit).toBe(1);
  });

  it("expires entries after the TTL", async () => {
    hits = {};
    const dir = mkdtempSync(join(tmpdir(), "hybld-cache-"));
    const fetcher = createFetcher({});
    fetcher.enableDiskCache({ dir, ttlMs: 1 });
    await fetcher(`${base}/ttl`);
    fetcher.clearMemo();
    await new Promise((r) => setTimeout(r, 10));
    await fetcher(`${base}/ttl`);
    expect(hits["/ttl"]).toBe(2);
  });

  it("bypasses the cache for freshness-critical URLs", async () => {
    hits = {};
    const dir = mkdtempSync(join(tmpdir(), "hybld-cache-"));
    const fetcher = createFetcher({ cacheBypass: (u) => u.includes("modified_after") });
    fetcher.enableDiskCache({ dir, ttlMs: 60_000 });
    await fetcher(`${base}/list?modified_after=x`);
    fetcher.clearMemo();
    await fetcher(`${base}/list?modified_after=x`);
    expect(hits["/list?modified_after=x"]).toBe(2);
  });
});

describe("RSS feed", () => {
  it("writes feed.xml from manifest feed refs, newest first, limited", () => {
    const dir = mkdtempSync(join(tmpdir(), "hybld-feed-"));
    const manifest = new Manifest(join(dir, "m.db"));
    const row = (n: number): ManifestRow => ({
      route: `/articles/a${n}/`,
      pageType: "article",
      articleId: String(n),
      slug: `a${n}`,
      sourceRef: null,
      dependentsRef: null,
      feedRef: JSON.stringify({ title: `Article ${n}`, description: `<p>Body ${n}</p>`, date: `2026-07-0${n}T00:00:00Z` }),
      contentHash: "x",
      cmsModifiedAt: `2026-07-0${n}T00:00:00Z`,
      builtAt: "2026-07-10T00:00:00Z",
      assetGraphHash: "h",
      outputPath: `articles/a${n}/index.html`,
    });
    for (const n of [1, 2, 3]) manifest.upsert(row(n));
    const writer = new OutputWriter(dir);
    const changed = writeFeed(manifest, writer, {
      enabled: true,
      baseUrl: "https://site.test",
      title: "Test Feed",
      description: "d",
      limit: 2,
    });
    expect(changed).toBe(true);
    const xml = readFileSync(join(dir, "feed.xml"), "utf8");
    expect(xml).toContain("<title>Test Feed</title>");
    expect(xml).toContain("https://site.test/articles/a3/");
    expect(xml).toContain("Article 2");
    expect(xml).not.toContain("Article 1"); // limit 2, newest first
    manifest.close();
  });
});

describe("sync + manifest push/pull", () => {
  it("applies the changed-files report to a target dir with redirects", () => {
    const outDir = mkdtempSync(join(tmpdir(), "hybld-out-"));
    const targetDir = mkdtempSync(join(tmpdir(), "hybld-target-"));
    mkdirSync(join(outDir, "articles/a"), { recursive: true });
    writeFileSync(join(outDir, "articles/a/index.html"), "A");
    writeFileSync(join(outDir, "sitemap.xml"), "S");
    writeFileSync(join(targetDir, "stale.html"), "old");
    const reportPath = join(outDir, "report.json");
    writeFileSync(
      reportPath,
      JSON.stringify({ files: { created: ["articles/a/index.html"], updated: ["sitemap.xml"], deleted: ["stale.html"] } })
    );
    const result = syncOutput({
      outDir,
      reportPath,
      targetDir,
      deleteRemoved: true,
      redirects: { format: "netlify", map: { "/old/": "/new/" } },
    });
    expect(result.copied.sort()).toEqual(["articles/a/index.html", "sitemap.xml"]);
    expect(readFileSync(join(targetDir, "articles/a/index.html"), "utf8")).toBe("A");
    expect(existsSync(join(targetDir, "stale.html"))).toBe(false);
    expect(readFileSync(join(targetDir, "_redirects"), "utf8")).toContain("/old/ /new/ 301");
  });

  it("pushes and pulls the manifest over HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hybld-mf-"));
    const src = join(dir, "src.db");
    writeFileSync(src, "sqlite-bytes-here");
    await pushManifest(src, `${base}/stored/m.db`);
    const dest = join(dir, "dest.db");
    await pullManifest(dest, `${base}/stored/m.db`);
    expect(readFileSync(dest, "utf8")).toBe("sqlite-bytes-here");
  });
});
