import { describe, expect, it, vi } from "vitest";

// Each case spawns several framework-build processes (or loads sharp).
vi.setConfig({ testTimeout: 60_000 });
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder, delegatedRenderer, validateConfig, type CmsAdapter } from "../dist/index.js";
import { ImageLocalizer } from "../dist/images.js";

/**
 * A fake framework build: emits one page per scope line plus a static home
 * and a per-build hashed asset, logs the page types it was handed, and fails
 * on demand (a "fail-on" file naming the build number to die on).
 */
const FAKE_BUILD = `
import { readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const cwd = process.cwd();
appendFileSync(join(cwd, "build-count.txt"), "x");
const n = readFileSync(join(cwd, "build-count.txt"), "utf8").length;
if (existsSync(join(cwd, "fail-on")) && Number(readFileSync(join(cwd, "fail-on"), "utf8")) === n) {
  console.error("simulated framework crash");
  process.exit(1);
}
const out = join(cwd, "fake-out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const jobs = readFileSync(process.env.HYBLD_SCOPE, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l));
appendFileSync(join(cwd, "scopes.log"), JSON.stringify(jobs.map((j) => j.pageType + ":" + j.route)) + "\\n");
for (const job of jobs) {
  const file = join(out, job.route.replace(/^\\/+/, "").replace(/\\/+$/, ""), "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "<html><body><h1>" + job.data.title + "</h1></body></html>");
}
writeFileSync(join(out, "index.html"), "<html><body><h1>Fake Home</h1></body></html>");
mkdirSync(join(out, "fake-assets"), { recursive: true });
writeFileSync(join(out, "fake-assets", "chunk-" + n + ".js"), "//js");
`;

const memoryAdapter = (items: any[]): CmsAdapter => ({
  name: "memory",
  count: async () => items.length,
  listArticles: async ({ page, perPage }) => ({
    items: items.slice((page - 1) * perPage, page * perPage),
    hasMore: page * perPage < items.length,
  }),
  getArticle: async (ref) => items.find((a) => String(a.id) === String(ref.id) || a.slug === ref.slug) ?? null,
});

function project() {
  const root = mkdtempSync(join(tmpdir(), "hybld-batch-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.js"), "// app");
  writeFileSync(join(root, "fake-build.mjs"), FAKE_BUILD);
  const articles = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, slug: `a${i + 1}`, title: `Article ${i + 1}` }));
  const authors = [{ id: 1, slug: "daya", name: "Daya" }];
  const make = (batchSize?: number) =>
    new Builder(
      validateConfig(
        {
          adapter: memoryAdapter(articles),
          renderer: delegatedRenderer({
            name: "fake",
            buildCommand: [process.execPath, "fake-build.mjs"],
            frameworkOutDir: "fake-out",
            sourceDirs: ["src"],
            assetDirs: ["fake-assets"],
            pageFileCandidates: (route: string) => [`${route.replace(/^\/+/, "").replace(/\/+$/, "")}/index.html`],
          }),
          outDir: "site",
          manifest: ".hybld/manifest.db",
          render: { batchSize },
          sitemap: { enabled: true, baseUrl: "https://example.test" },
          pages: {
            article: { route: (a: any) => `/articles/${a.slug}/`, data: (a: any) => ({ title: a.title }) },
            author: {
              collection: true,
              adapter: memoryAdapter(authors),
              route: (a: any) => `/authors/${a.slug}/`,
              data: (a: any) => ({ title: `Author: ${a.name}` }),
            },
          },
        } as any,
        root
      )
    );
  const builds = () => (existsSync(join(root, "build-count.txt")) ? readFileSync(join(root, "build-count.txt"), "utf8").length : 0);
  const scopes = (): string[][] =>
    readFileSync(join(root, "scopes.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { root, make, builds, scopes };
}

describe("delegated batching (render.batchSize)", () => {
  it("splits a large scope into several framework builds, each carrying every page type", async () => {
    const p = project();
    const b = p.make(3);
    const summary = await b.build({ all: true });
    await b.close();

    expect(summary.failed).toEqual([]);
    expect(p.builds()).toBe(3); // 8 pages at 3 per build
    // Each page is reported once, although the padding page rode in several batches.
    expect(summary.built.length).toBe(8);
    expect(new Set(summary.built).size).toBe(8);
    for (const scope of p.scopes()) {
      const types = new Set(scope.map((s) => s.split(":")[0]));
      expect(types.has("article")).toBe(true);
      expect(types.has("author")).toBe(true);
    }
    for (let i = 1; i <= 7; i++) expect(existsSync(join(p.root, `site/articles/a${i}/index.html`))).toBe(true);
    expect(existsSync(join(p.root, "site/authors/daya/index.html"))).toBe(true);
    // Every batch's hashed asset was merged, not only the last one's.
    expect(readdirSync(join(p.root, "site/fake-assets")).sort()).toEqual(["chunk-1.js", "chunk-2.js", "chunk-3.js"]);
    expect(readFileSync(join(p.root, "site/sitemap.xml"), "utf8").length).toBeGreaterThan(0);
  });

  it("--batch-size style override wins over the config, and one batch stays one build", async () => {
    const p = project();
    const b = p.make(3);
    await b.build({ all: true, batchSize: 100 });
    await b.close();
    expect(p.builds()).toBe(1);
  });

  it("a crash in a later batch keeps the batches already merged; the rerun builds only the rest", async () => {
    const p = project();
    writeFileSync(join(p.root, "fail-on"), "2");
    const b1 = p.make(3);
    await expect(b1.build({ all: true })).rejects.toThrow(/simulated framework crash/);
    await b1.close();

    rmSync(join(p.root, "fail-on"));
    const b2 = p.make(3);
    const summary = await b2.build({ all: true });
    await b2.close();

    expect(summary.failed).toEqual([]);
    // Batch 1 (3 pages plus the author padding) survived the crash.
    expect(summary.skipped.length).toBeGreaterThanOrEqual(3);
    expect(summary.built.length).toBeLessThanOrEqual(5);
    expect(summary.built.length + summary.skipped.length).toBe(8);
    for (let i = 1; i <= 7; i++) expect(existsSync(join(p.root, `site/articles/a${i}/index.html`))).toBe(true);
    // The sitemap covers the whole catalog, including pages from the crashed run.
    const sitemaps = readdirSync(join(p.root, "site")).filter((f) => f.startsWith("sitemap")).map((f) => readFileSync(join(p.root, "site", f), "utf8")).join("");
    for (let i = 1; i <= 7; i++) expect(sitemaps).toContain(`/articles/a${i}/`);
  });

  it("rejects a non-positive render.batchSize", () => {
    const p = project();
    expect(() => p.make(0)).toThrow(/render.batchSize/);
  });
});

describe("image optimization (images.optimize)", () => {
  it("caps width, re-encodes raster images, and leaves SVG untouched", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#228866" } }).png().toBuffer();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/big.png")) return void res.writeHead(200, { "content-type": "image/png" }).end(png);
      if (req.url?.startsWith("/icon.svg")) return void res.writeHead(200, { "content-type": "image/svg+xml" }).end(svg);
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const outDir = mkdtempSync(join(tmpdir(), "hybld-img-"));

    const localizer = new ImageLocalizer({
      origins: [origin],
      dir: "media",
      outDir,
      optimize: { maxWidth: 800, format: "webp", quality: 70 },
    });
    await localizer.init();
    const { html, downloaded } = await localizer.localizeHtml(
      `<img src="${origin}/big.png"><img src="${origin}/icon.svg">`
    );
    server.close();

    expect(downloaded.length).toBe(2);
    const webp = downloaded.find((d) => d.endsWith(".webp"))!;
    const svgLocal = downloaded.find((d) => d.endsWith(".svg"))!;
    expect(webp).toBeTruthy();
    expect(svgLocal).toBeTruthy();
    expect(html).not.toContain(origin);

    const meta = await sharp(join(outDir, webp)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(400);
    expect(readFileSync(join(outDir, webp)).length).toBeLessThan(png.length);
    expect(readFileSync(join(outDir, svgLocal)).equals(svg)).toBe(true);

    // Different settings produce a different file name, never a stale reuse.
    const other = new ImageLocalizer({ origins: [origin], dir: "media", outDir, optimize: { maxWidth: 400, format: "webp", quality: 70 } });
    expect((other as any).localPathFor(`${origin}/big.png`)).not.toBe(webp);
  });

  it("rejects invalid optimize settings in the config", () => {
    const base: any = {
      adapter: memoryAdapter([]),
      pages: { article: { route: () => "/", data: () => ({}) } },
    };
    expect(() =>
      validateConfig({ ...base, images: { origins: ["https://cms.test"], optimize: { format: "bmp" } } }, tmpdir())
    ).toThrow(/images.optimize.format/);
    expect(() =>
      validateConfig({ ...base, images: { origins: ["https://cms.test"], optimize: { quality: 0 } } }, tmpdir())
    ).toThrow(/images.optimize.quality/);
  });
});
