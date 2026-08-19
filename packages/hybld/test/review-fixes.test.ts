import { describe, expect, it, beforeAll } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Builder,
  ImageLocalizer,
  Manifest,
  OutputWriter,
  createFetcher,
  delegatedRenderer,
  routeToOutputPath,
  validateConfig,
  writeFeed,
  type CmsAdapter,
} from "../dist/index.js";
import { writeSitemap } from "../dist/sitemap.js";
import { BoundedTtlCache } from "../dist/serve.js";

describe("output path safety (CMS-controlled slugs)", () => {
  it("rejects routes with .. or . segments", () => {
    expect(() => routeToOutputPath("/../../etc/passwd")).toThrow(/Unsafe route/);
    expect(() => routeToOutputPath("/a/../b/")).toThrow(/Unsafe route/);
    expect(() => routeToOutputPath("/./a/")).toThrow(/Unsafe route/);
    expect(() => routeToOutputPath("/a\\b/")).toThrow(/Unsafe route/);
  });

  it("still maps normal routes, collapsing empty segments", () => {
    expect(routeToOutputPath("/")).toBe("index.html");
    expect(routeToOutputPath("/articles/hello/")).toBe("articles/hello/index.html");
    expect(routeToOutputPath("/a//b/")).toBe("a/b/index.html");
    expect(routeToOutputPath("/404.html")).toBe("404.html");
  });

  it("OutputWriter refuses to write or delete outside outDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "vg-out-"));
    const writer = new OutputWriter(dir);
    expect(() => writer.writePage("../evil.html", "x")).toThrow(/outside outDir/);
    expect(() => writer.deletePage("../../etc/passwd")).toThrow(/outside outDir/);
    writer.writePage("ok/index.html", "fine");
    expect(readFileSync(join(dir, "ok/index.html"), "utf8")).toBe("fine");
  });
});

describe("image localization", () => {
  const fakeFetcher = (async (_url: string) => new Response(Buffer.from("img-bytes"))) as any;

  it("handles srcset candidates and HTML-escaped query strings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vg-img-"));
    const localizer = new ImageLocalizer({
      origins: ["https://cms.example.com"],
      dir: "media",
      outDir: dir,
      fetcher: fakeFetcher,
    });
    const html = [
      `<img src="https://cms.example.com/a.jpg?w=800&amp;fmt=webp">`,
      `<img srcset="https://cms.example.com/b-400.jpg 400w, https://cms.example.com/b-800.jpg 800w">`,
    ].join("\n");
    const out = (await localizer.localizeHtml(html)).html;
    expect(out).not.toContain("cms.example.com");
    expect(out).toMatch(/media\/[0-9a-f]{16}\.jpg\?*/);
    // Three distinct URLs downloaded.
    expect(localizer.drainNewFiles()).toHaveLength(3);
  });
});

describe("fetcher hardening", () => {
  it("times out hung requests instead of stalling forever", async () => {
    const server = createServer(() => {
      /* never respond */
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const fetcher = createFetcher({ timeoutMs: 200, retries: 0, memoize: false });
    await expect(fetcher(`http://127.0.0.1:${port}/hang`)).rejects.toThrow(/timed out/);
    server.close();
  });
});

describe("sitemap and feed output hygiene", () => {
  it("deletes orphaned sitemap shards when the catalog shrinks", () => {
    const dir = mkdtempSync(join(tmpdir(), "vg-sm-"));
    const writer = new OutputWriter(dir);
    const row = (i: number) => ({
      route: `/p/${String(i).padStart(6, "0")}/`,
      cmsModifiedAt: "2026-01-01T00:00:00Z",
      builtAt: "2026-01-01T00:00:00Z",
    });
    const big = { all: () => Array.from({ length: 50_001 }, (_, i) => row(i)) } as any;
    writeSitemap(big, writer, "https://example.com");
    expect(existsSync(join(dir, "sitemap-1.xml"))).toBe(true);

    const small = { all: () => [row(1)] } as any;
    writeSitemap(small, writer, "https://example.com");
    expect(existsSync(join(dir, "sitemap-0.xml"))).toBe(true);
    expect(existsSync(join(dir, "sitemap-1.xml"))).toBe(false);
    expect(readFileSync(join(dir, "sitemap.xml"), "utf8")).not.toContain("sitemap-1.xml");
  });

  it("omits pubDate instead of emitting 'Invalid Date' for malformed dates", () => {
    const dir = mkdtempSync(join(tmpdir(), "vg-feed-"));
    const writer = new OutputWriter(dir);
    const manifest = {
      feedRows: () => [
        {
          route: "/a/",
          slug: "a",
          feedRef: JSON.stringify({ title: "A", date: "not-a-date" }),
          cmsModifiedAt: "also-bad",
          builtAt: "2026-02-01T00:00:00Z",
        },
      ],
    } as any;
    writeFeed(manifest, writer, { enabled: true, baseUrl: "https://x.com", title: "t", description: "", limit: 20 });
    const xml = readFileSync(join(dir, "feed.xml"), "utf8");
    expect(xml).not.toContain("Invalid Date");
    expect(xml).toContain("<pubDate>"); // fell back to builtAt
  });
});

describe("serve static: percent-encoded paths", () => {
  it("serves files under bracket dirs (Next [slug] chunks) and still blocks encoded traversal", async () => {
    const { startServer } = await import("../dist/serve.js");
    const outDir = mkdtempSync(join(tmpdir(), "vg-serve-"));
    mkdirSync(join(outDir, "chunks", "app", "[slug]"), { recursive: true });
    writeFileSync(join(outDir, "chunks", "app", "[slug]", "page-abc.js"), "//chunk");
    writeFileSync(join(outDir, "index.html"), "<h1>home</h1>");
    const fakeBuilder: any = {
      config: { outDir, pages: {} },
      backendMode: "owned",
      build: async () => ({ built: [], failed: [] }),
    };
    const server = startServer(fakeBuilder, { port: 0, serveStatic: true });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as any).port;
    const get = async (p: string) => (await fetch(`http://127.0.0.1:${port}${p}`)).status;

    expect(await get("/index.html")).toBe(200);
    // The bug: browsers request Next's [slug] chunk dirs percent-encoded.
    expect(await get("/chunks/app/%5Bslug%5D/page-abc.js")).toBe(200);
    // Encoded traversal must stay blocked (decode happens BEFORE the guard).
    expect(await get("/%2e%2e/%2e%2e/etc/passwd")).toBe(404);
    expect(await get("/chunks/%2e%2e/%2e%2e/%2e%2e/etc/passwd")).toBe(404);
    // Malformed encoding: clean 404, not a crash.
    expect(await get("/%zz")).toBe(404);
    server.close();
  });
});

describe("serve regen negative cache (BoundedTtlCache)", () => {
  it("expires entries after the TTL", async () => {
    const c = new BoundedTtlCache(30, 100);
    c.add("/a/");
    expect(c.has("/a/")).toBe(true);
    await new Promise((r) => setTimeout(r, 45));
    expect(c.has("/a/")).toBe(false);
    expect(c.size).toBe(0);
  });

  it("caps its size by evicting the stalest entries (junk-URL flood safety)", () => {
    const c = new BoundedTtlCache(60_000, 3);
    c.add("/a/");
    c.add("/b/");
    c.add("/c/");
    c.add("/d/");                    // over cap: /a/ (oldest) evicted
    expect(c.size).toBe(3);
    expect(c.has("/a/")).toBe(false);
    expect(c.has("/b/") && c.has("/c/") && c.has("/d/")).toBe(true);

    c.add("/b/");                    // refresh recency of /b/
    c.add("/e/");                    // now /c/ is the stalest
    expect(c.size).toBe(3);
    expect(c.has("/c/")).toBe(false);
    expect(c.has("/b/") && c.has("/d/") && c.has("/e/")).toBe(true);

    // a sustained flood never exceeds the cap
    for (let i = 0; i < 500; i++) c.add(`/junk-${i}/`);
    expect(c.size).toBe(3);
  });
});

describe("scope resolution hardening (fake delegated backend)", () => {
  let root: string;

  const FAKE_BUILD = `
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
const out = join(process.cwd(), "fake-out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const lines = readFileSync(process.env.HYBLD_SCOPE, "utf8").split("\\n").filter(Boolean);
for (const line of lines) {
  const job = JSON.parse(line);
  const rel = job.route === "/" ? "index.html" : job.route.replace(/^\\/+/, "").replace(/\\/+$/, "") + "/index.html";
  const file = join(out, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "<html><body>" + job.data.title + "</body></html>");
}
`;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "vg-scope-"));
    writeFileSync(join(root, "fake-build.mjs"), FAKE_BUILD);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "app.js"), "// source");
  });

  const uuidAdapter = (order: any[]): CmsAdapter => ({
    name: "uuid-memory",
    count: async () => order.length,
    listArticles: async ({ page, perPage }) => ({
      items: order.slice((page - 1) * perPage, page * perPage),
      hasMore: page * perPage < order.length,
    }),
    getArticle: async (ref) => order.find((a) => a.slug === ref.slug || a.id === ref.id) ?? null,
  });

  const makeBuilder = (adapter: CmsAdapter, subdir: string) => {
    const raw: any = {
      adapter,
      renderer: delegatedRenderer({
        name: "fake",
        buildCommand: [process.execPath, "fake-build.mjs"],
        frameworkOutDir: "fake-out",
        sourceDirs: ["src"],
        assetDirs: [],
        pageFileCandidates: (route: string) => [
          route === "/" ? "index.html" : `${route.replace(/^\/+/, "").replace(/\/+$/, "")}/index.html`,
        ],
      }),
      outDir: `site-${subdir}`,
      manifest: `.hybld-${subdir}/manifest.db`,
      pages: { article: { route: (a: any) => `/articles/${a.slug}/`, data: (a: any) => ({ title: a.title }) } },
    };
    return new Builder(validateConfig(raw, root));
  };

  it("chunk partitioning is identical for string ids regardless of CMS fetch order", async () => {
    const items = [
      { id: "b7f3", slug: "one", title: "1" },
      { id: "a1c9", slug: "two", title: "2" },
      { id: "d804", slug: "three", title: "3" },
      { id: "c2e5", slug: "four", title: "4" },
    ];
    const shuffled = [items[2], items[0], items[3], items[1]];
    const chunksOf = async (order: any[], tag: string) => {
      const routes: string[][] = [];
      for (const index of [1, 2]) {
        const b = makeBuilder(uuidAdapter(order), `${tag}-${index}`);
        const summary = await b.build({ chunk: { index, total: 2 }, dryRun: true });
        routes.push((summary.plannedRoutes ?? []).sort());
        await b.close();
      }
      return routes;
    };
    const [a1, a2] = await chunksOf(items, "orderA");
    const [b1, b2] = await chunksOf(shuffled, "orderB");
    expect(a1).toEqual(b1);
    expect(a2).toEqual(b2);
    expect([...a1, ...a2].sort()).toHaveLength(4);
  });

  it("--limit bounds the whole build, not each collection", async () => {
    const one = uuidAdapter([
      { id: "1", slug: "a1", title: "a1" },
      { id: "2", slug: "a2", title: "a2" },
    ]);
    const two = uuidAdapter([
      { id: "3", slug: "b1", title: "b1" },
      { id: "4", slug: "b2", title: "b2" },
    ]);
    const raw: any = {
      adapter: one,
      renderer: delegatedRenderer({
        name: "fake",
        buildCommand: [process.execPath, "fake-build.mjs"],
        frameworkOutDir: "fake-out",
        sourceDirs: ["src"],
        assetDirs: [],
        pageFileCandidates: (route: string) => [`${route.replace(/^\/+/, "").replace(/\/+$/, "")}/index.html`],
      }),
      outDir: "site-limit",
      manifest: ".hybld-limit/manifest.db",
      pages: {
        article: { route: (a: any) => `/articles/${a.slug}/`, data: (a: any) => ({ title: a.title }) },
        author: { collection: true, adapter: two, route: (a: any) => `/authors/${a.slug}/`, data: (a: any) => ({ title: a.title }) },
      },
    };
    const b = new Builder(validateConfig(raw, root));
    const summary = await b.build({ limit: 3, dryRun: true });
    await b.close();
    const collectionRoutes = (summary.plannedRoutes ?? []).filter((r) => r.startsWith("/articles/") || r.startsWith("/authors/"));
    expect(collectionRoutes).toHaveLength(3);
  });

  it("aborts instead of looping forever when the CMS ignores the page param", async () => {
    const stuck: CmsAdapter = {
      name: "stuck",
      count: async () => {
        throw new Error("no count");
      },
      listArticles: async () => ({
        items: [{ id: "1", slug: "same", title: "same" }],
        hasMore: true, // forever
      }),
      getArticle: async () => null,
    };
    const b = makeBuilder(stuck, "stuck");
    await expect(b.build({ all: true, dryRun: true })).rejects.toThrow(/identical consecutive pages/);
    await b.close();
  });

  it("releases the fetcher memo at the END of a run, not just the start (serve-mode idle memory)", async () => {
    let clears = 0;
    const adapter: any = uuidAdapter([{ id: "1", slug: "m", title: "m" }]);
    adapter.fetcher = Object.assign(async () => new Response("{}"), {
      clearMemo: () => clears++,
      requestCount: () => 0,
    });
    const b = makeBuilder(adapter, "memoclear");
    await b.build({ all: true, dryRun: true });
    await b.close();
    // once at run start, once in the run's finally
    expect(clears).toBe(2);
  });

  it("refuses --clean with a narrow scope (it would wipe the site down to the scoped pages)", async () => {
    const b = makeBuilder(uuidAdapter([{ id: "1", slug: "a", title: "a" }]), "cleanguard");
    await expect(b.build({ slugs: ["a"], clean: true })).rejects.toThrow(/--clean.*--all/s);
    await expect(b.build({ since: "last-build", clean: true })).rejects.toThrow(/--clean.*--all/s);
    // --all --clean stays allowed (dry run to avoid a real framework build)
    const summary = await b.build({ all: true, clean: true, dryRun: true });
    expect(summary.dryRun).toBe(true);
    await b.close();
  });

  it("reconcile and targeted builds do not advance the --since cursor; --all and --since do", async () => {
    let items = [
      { id: "1", slug: "a1", title: "a1", modified: "2026-07-01T00:00:00Z" },
      { id: "2", slug: "a2", title: "a2", modified: "2026-07-01T00:00:00Z" },
    ];
    const adapter: CmsAdapter = {
      name: "cursor-memory",
      count: async () => items.length,
      listArticles: async ({ page, perPage }) => ({
        items: items.slice((page - 1) * perPage, page * perPage),
        hasMore: page * perPage < items.length,
      }),
      getArticle: async (ref) => items.find((a) => a.slug === ref.slug || a.id === ref.id) ?? null,
      listModifiedSince: async (date, { page, perPage }) => {
        const all = items.filter((a) => new Date(a.modified).getTime() > date.getTime());
        return { items: all.slice((page - 1) * perPage, page * perPage), hasMore: page * perPage < all.length };
      },
    };
    const manifestRel = ".hybld-cursor/manifest.db";
    const cursor = () => {
      const m = new Manifest(join(root, manifestRel));
      const v = m.getMeta("lastBuildAt");
      m.close();
      return v;
    };
    const build = async (opts: any) => {
      const raw: any = {
        adapter,
        renderer: delegatedRenderer({
          name: "fake",
          buildCommand: [process.execPath, "fake-build.mjs"],
          frameworkOutDir: "fake-out",
          sourceDirs: ["src"],
          assetDirs: [],
          pageFileCandidates: (route: string) => [`${route.replace(/^\/+/, "").replace(/\/+$/, "")}/index.html`],
        }),
        outDir: "site-cursor",
        manifest: manifestRel,
        pages: { article: { route: (a: any) => `/articles/${a.slug}/`, data: (a: any) => ({ title: a.title }) } },
      };
      const b = new Builder(validateConfig(raw, root));
      const s = await b.build(opts);
      await b.close();
      return s;
    };

    await build({ all: true });
    const afterAll = cursor();
    expect(afterAll).toBeTruthy();

    // A targeted build must not advance the cursor.
    await build({ slugs: ["a1"] });
    expect(cursor()).toBe(afterAll);

    // A reconcile sweep finds no orphans and must NOT advance the cursor: it
    // never processes modifications, so advancing it would skip everything
    // modified since the last real --since run.
    await build({ reconcile: true });
    expect(cursor()).toBe(afterAll);

    // Prove the cursor is still usable: an article modified AFTER the full
    // build is picked up by --since last-build (would be missed if reconcile
    // had advanced the cursor past it).
    items = items.map((a) => (a.slug === "a2" ? { ...a, title: "a2-edited", modified: new Date().toISOString() } : a));
    const since = await build({ since: "last-build" });
    expect(since.built).toContain("/articles/a2/");
    // ...and --since DID advance the cursor.
    expect(cursor()).not.toBe(afterAll);
  });
});
