// Engine benchmark (NFR-8): synthetic catalog, trivial in-memory renderer,
// so the numbers isolate hybld's own cost (scope resolution, hashing,
// manifest, output writes, sitemap/feed) from any framework's render time.
//
//   node scripts/bench.mjs [articleCount]
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Builder, validateConfig } from "../packages/hybld/dist/index.js";

const N = Number(process.argv[2] ?? 50_000);
const root = mkdtempSync(join(tmpdir(), "hybld-bench-"));

const articles = Array.from({ length: N }, (_, i) => ({
  id: i + 1,
  slug: `article-${i + 1}`,
  title: `Benchmark Article ${i + 1}`,
  body: `<p>Body of article ${i + 1}, long enough to look like content.</p>`.repeat(4),
  modified: new Date(1700000000000 + i * 60_000).toISOString(),
}));

const adapter = {
  name: "bench",
  count: async () => articles.length,
  listArticles: async ({ page, perPage }) => ({
    items: articles.slice((page - 1) * perPage, page * perPage),
    hasMore: page * perPage < articles.length,
  }),
  getArticle: async (ref) =>
    articles.find((a) => String(a.id) === String(ref.id) || a.slug === ref.slug) ?? null,
  listModifiedSince: async (date, { page, perPage }) => {
    const hits = articles.filter((a) => new Date(a.modified) > date);
    return { items: hits.slice((page - 1) * perPage, page * perPage), hasMore: page * perPage < hits.length };
  },
};

const benchBackend = {
  name: "bench",
  mode: "owned",
  assetDirs: [],
  assetFiles: [],
  assetGraphHash: "bench-code-1",
  async prepare() {},
  async renderBatch(jobs) {
    return jobs.map((j) => ({
      route: j.route,
      kind: "html",
      html: `<html><head><title>${j.data.title}</title></head><body>${j.data.body ?? ""}</body></html>`,
    }));
  },
  pageSidecars: () => [],
  destroy() {},
};

const config = validateConfig(
  {
    adapter,
    renderer: { name: "bench", mode: "owned", create: () => benchBackend },
    outDir: "site",
    manifest: ".hybld/manifest.db",
    cms: { perPage: 500, concurrency: 8 },
    pages: {
      article: {
        route: (a) => `/articles/${a.slug}/`,
        data: (a) => ({ title: a.title, body: a.body }),
      },
      home: {
        route: () => "/",
        data: async ({ cms }) => ({ latest: (await cms.list({ perPage: 10 })).map((a) => a.slug) }),
      },
    },
    sitemap: { enabled: true, baseUrl: "https://bench.example.com" },
    feed: { enabled: true, title: "Bench", description: "" },
  },
  root
);

const fmt = (ms) => `${(ms / 1000).toFixed(2)}s`;
const run = async (label, fn) => {
  const t0 = performance.now();
  const summary = await fn();
  const ms = performance.now() - t0;
  const rate = summary.built.length ? ` (${Math.round(summary.built.length / (ms / 1000))} pages/s)` : "";
  console.log(
    `${label.padEnd(34)} ${fmt(ms).padStart(8)}  built=${summary.built.length} skipped=${summary.skipped.length} deleted=${summary.deleted.length}${rate}`
  );
  return summary;
};

console.log(`hybld engine benchmark: ${N.toLocaleString()} articles, root=${root}\n`);
const builder = new Builder(config);

await run(`full build (${N.toLocaleString()} pages)`, () => builder.build({ all: true }));
await run("no-change rebuild (all skips)", () => builder.build({ all: true }));

// Builds now finish fast enough that a same-millisecond timestamp would be
// filtered by the strict modified > lastBuildAt comparison; step the clock.
const tick = () => new Promise((r) => setTimeout(r, 20));

await tick();
articles.push({
  id: N + 1,
  slug: "fresh-article",
  title: "Fresh Article",
  body: "<p>new</p>",
  modified: new Date().toISOString(),
});
await run("incremental publish (1 article)", () => builder.build({ since: "last-build" }));

await tick();
articles[500].title = "Edited Title";
articles[500].modified = new Date().toISOString();
await run("incremental edit (1 article)", () => builder.build({ since: "last-build" }));

const status = await builder.status();
console.log(`\nmanifest rows: ${status.totalPages.toLocaleString()}`);
await builder.close();
