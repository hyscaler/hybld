import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Builder, delegatedRenderer, validateConfig, type CmsAdapter } from "../dist/index.js";

/**
 * Exercises the delegated "scoped build and merge" strategy end to end against
 * a fake framework: a node script that reads the NDJSON scope file and emits
 * HTML pages, a static home page (extra), and a hashed asset per build.
 */

const FAKE_BUILD = `
import { readFileSync, writeFileSync, mkdirSync, rmSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

const out = join(process.cwd(), "fake-out");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
appendFileSync(join(process.cwd(), "build-count.txt"), "x"); // one char per framework build

const lines = readFileSync(process.env.HYBLD_SCOPE, "utf8").split("\\n").filter(Boolean);
for (const line of lines) {
  const job = JSON.parse(line);
  const rel = job.route === "/" ? "index.html" : job.route.replace(/^\\/+/, "").replace(/\\/+$/, "") + "/index.html";
  const file = join(out, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, \`<html><body data-type="\${job.pageType}"><h1>\${job.data.title}</h1></body></html>\`);
}
// Static route the framework always rebuilds (like a Next/Astro home page):
writeFileSync(join(out, "index.html"), "<html><body><h1>Fake Home</h1></body></html>");
// A hashed runtime asset that differs per build (like a Next buildId chunk):
mkdirSync(join(out, "fake-assets"), { recursive: true });
writeFileSync(join(out, "fake-assets", "chunk-" + Date.now() + ".js"), "//js");
`;

let root: string;
let articles: any[];
let authors: any[];

const memoryAdapter = (items: () => any[]): CmsAdapter => ({
  name: "memory",
  count: async () => items().length,
  listArticles: async ({ page, perPage }) => {
    const all = items();
    return { items: all.slice((page - 1) * perPage, page * perPage), hasMore: page * perPage < all.length };
  },
  getArticle: async (ref) =>
    items().find((a) => String(a.id) === String(ref.id) || a.slug === ref.slug) ?? null,
  listModifiedSince: async (date, { page, perPage }) => {
    const all = items().filter((a) => new Date(a.modified).getTime() > date.getTime());
    return { items: all.slice((page - 1) * perPage, page * perPage), hasMore: page * perPage < all.length };
  },
});

function makeBuilder(): Builder {
  const raw: any = {
    adapter: memoryAdapter(() => articles),
    renderer: delegatedRenderer({
      name: "fake",
      buildCommand: [process.execPath, "fake-build.mjs"],
      frameworkOutDir: "fake-out",
      sourceDirs: ["src"],
      assetDirs: ["fake-assets"],
      pageFileCandidates: (route: string) => [
        route === "/" ? "index.html" : `${route.replace(/^\/+/, "").replace(/\/+$/, "")}/index.html`,
      ],
    }),
    outDir: "site",
    manifest: ".hybld/manifest.db",
    pages: {
      article: {
        route: (a: any) => `/articles/${a.slug}/`,
        data: (a: any) => ({ title: a.title }),
      },
      author: {
        collection: true,
        adapter: memoryAdapter(() => authors),
        route: (a: any) => `/authors/${a.slug}/`,
        data: (a: any) => ({ title: `Author: ${a.name}` }),
      },
    },
  };
  return new Builder(validateConfig(raw, root));
}

const buildCount = () =>
  existsSync(join(root, "build-count.txt")) ? readFileSync(join(root, "build-count.txt"), "utf8").length : 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "hybld-delegated-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.js"), "// app source v1");
  writeFileSync(join(root, "fake-build.mjs"), FAKE_BUILD);
  articles = [
    { id: 1, slug: "one", title: "Article One", modified: "2026-07-01T00:00:00Z" },
    { id: 2, slug: "two", title: "Article Two", modified: "2026-07-02T00:00:00Z" },
  ];
  authors = [{ id: 1, slug: "daya", name: "Daya", modified: "2026-07-01T00:00:00Z" }];
});

describe("delegated backend (scoped build and merge)", () => {
  it("full build: scoped pages merged, extras merged, assets copied append-only", async () => {
    const b = makeBuilder();
    const summary = await b.build({ all: true });
    await b.close();
    expect(summary.failed).toEqual([]);
    expect(summary.built.sort()).toEqual(["/articles/one/", "/articles/two/", "/authors/daya/"]);
    expect(readFileSync(join(root, "site/articles/one/index.html"), "utf8")).toContain("Article One");
    expect(readFileSync(join(root, "site/authors/daya/index.html"), "utf8")).toContain("Author: Daya");
    // The framework's always-rebuilt static home came back as an extra page.
    expect(readFileSync(join(root, "site/index.html"), "utf8")).toContain("Fake Home");
    expect(buildCount()).toBe(1);
  });

  it("no-change rebuild: everything skips and the framework build never runs", async () => {
    const b = makeBuilder();
    const summary = await b.build({ all: true });
    await b.close();
    expect(summary.built).toEqual([]);
    expect(summary.skipped.length).toBeGreaterThanOrEqual(3);
    expect(buildCount()).toBe(1); // unchanged: no second framework build
  });

  it("incremental publish: one framework build, new page written, old article files untouched", async () => {
    const before = readFileSync(join(root, "site/articles/one/index.html"), "utf8");
    articles.push({ id: 3, slug: "three", title: "Article Three", modified: new Date().toISOString() });
    const b = makeBuilder();
    const summary = await b.build({ since: "last-build" });
    await b.close();
    // Batch padding: the author collection had no jobs this run, so one
    // already-built author page rides along (Next export requires non-empty
    // generateStaticParams for every dynamic route type), but since its
    // content did not change it is reported as skipped, not built.
    expect(summary.built).toEqual(["/articles/three/"]);
    expect(summary.skipped).toContain("/authors/daya/");
    expect(readFileSync(join(root, "site/articles/three/index.html"), "utf8")).toContain("Article Three");
    expect(readFileSync(join(root, "site/articles/one/index.html"), "utf8")).toBe(before);
    expect(buildCount()).toBe(2);
  });

  it("targeted rebuild of an UNCHANGED page keeps every route type in the batch (no empty generateStaticParams)", async () => {
    const b = makeBuilder();
    // Article "one" is fresh (unchanged since its last build); freshness
    // skipping must not empty the article type out of the framework batch.
    const summary = await b.build({ slugs: ["one"] });
    await b.close();
    expect(summary.failed).toEqual([]);
    expect(summary.built).toEqual([]);
    expect(summary.skipped).toContain("/articles/one/");
    const scope = readFileSync(join(root, ".hybld/scope.ndjson"), "utf8");
    const types = new Set(scope.split("\n").filter(Boolean).map((l) => JSON.parse(l).pageType));
    expect(types.has("article")).toBe(true);
    expect(types.has("author")).toBe(true);
  });

  it("targets a non-default collection with the type:value syntax", async () => {
    authors[0].name = "Daya Updated";
    const b = makeBuilder();
    const summary = await b.build({ ids: ["author:1"] });
    await b.close();
    expect(summary.built).toEqual(["/authors/daya/"]);
    // The padding page from the article collection rode along unchanged.
    expect(summary.skipped).toHaveLength(1);
    expect(readFileSync(join(root, "site/authors/daya/index.html"), "utf8")).toContain("Daya Updated");
  });

  it("uses a source fingerprint as the asset graph hash, so rebuilds do not churn code-staleness", async () => {
    const b = makeBuilder();
    const s1 = await b.status();
    expect(s1.codeStale).toBe(0); // multiple framework builds happened, same source, no churn

    writeFileSync(join(root, "src", "app.js"), "// app source v2 (changed)");
    const b2 = makeBuilder();
    const summary = await b2.build({ stale: true });
    expect(summary.assetGraphHash).not.toBe(s1.currentAssetGraphHash);
    expect(summary.built.length).toBeGreaterThanOrEqual(4); // all pages converge onto new code
    const s2 = await b2.status();
    expect(s2.codeStale).toBe(0);
    await b.close();
    await b2.close();
  });

  it("accumulates per-build runtime assets under one source hash (union recording)", async () => {
    // Two framework builds ran under the v1 source hash; both chunk files were
    // recorded, so gc keeps current-graph files and removes superseded ones only.
    const b = makeBuilder();
    const result = await b.gcAssets(true);
    await b.close();
    expect(result.skipped).toBeUndefined();
    // v1-source chunks are no longer live (all pages rebuilt on v2), so they are deletable.
    expect(result.deleted.length).toBeGreaterThanOrEqual(1);
    expect(result.kept).toBeGreaterThanOrEqual(1);
  });
});
