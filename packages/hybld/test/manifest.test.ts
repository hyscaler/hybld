import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Manifest, type ManifestRow } from "../dist/index.js";

const row = (route: string, over: Partial<ManifestRow> = {}): ManifestRow => ({
  route,
  pageType: "article",
  articleId: "1",
  slug: "a",
  sourceRef: null,
  dependentsRef: null,
  feedRef: null,
  contentHash: "abc",
  cmsModifiedAt: "2026-07-01T00:00:00Z",
  builtAt: "2026-07-02T00:00:00Z",
  assetGraphHash: "hash1",
  outputPath: "a/index.html",
  ...over,
});

const fresh = () => new Manifest(join(mkdtempSync(join(tmpdir(), "hybld-mf-")), "m.db"));

describe("Manifest", () => {
  it("upserts and reads rows", () => {
    const m = fresh();
    m.upsert(row("/a/"));
    expect(m.get("/a/")?.contentHash).toBe("abc");
    m.upsert(row("/a/", { contentHash: "def" }));
    expect(m.get("/a/")?.contentHash).toBe("def");
    expect(m.all()).toHaveLength(1);
    m.close();
  });

  it("finds rows by article id and slug", () => {
    const m = fresh();
    m.upsert(row("/a/", { articleId: "42", slug: "answer" }));
    expect(m.byArticleId(42)?.route).toBe("/a/");
    expect(m.bySlug("answer")?.route).toBe("/a/");
    m.close();
  });

  it("reports code-stale rows oldest-built first", () => {
    const m = fresh();
    m.upsert(row("/old/", { assetGraphHash: "hash0", builtAt: "2026-01-01T00:00:00Z" }));
    m.upsert(row("/older/", { articleId: "2", slug: "b", assetGraphHash: "hash0", builtAt: "2025-01-01T00:00:00Z" }));
    m.upsert(row("/current/", { articleId: "3", slug: "c", assetGraphHash: "hash1" }));
    const stale = m.codeStale("hash1");
    expect(stale.map((r) => r.route)).toEqual(["/older/", "/old/"]);
    expect(m.codeStaleCount("hash1")).toBe(2);
    expect(m.codeStale("hash1", 1)).toHaveLength(1);
    m.close();
  });

  it("merges another manifest with newest builtAt winning", () => {
    const dirA = mkdtempSync(join(tmpdir(), "hybld-mf-"));
    const a = new Manifest(join(dirA, "a.db"));
    const b = new Manifest(join(dirA, "b.db"));
    a.upsert(row("/x/", { contentHash: "fromA", builtAt: "2026-07-01T00:00:00Z" }));
    b.upsert(row("/x/", { contentHash: "fromB", builtAt: "2026-07-05T00:00:00Z" }));
    b.upsert(row("/y/", { articleId: "2", slug: "y" }));
    b.close();
    const merged = a.merge(join(dirA, "b.db"));
    expect(merged).toBe(2);
    expect(a.get("/x/")?.contentHash).toBe("fromB");
    expect(a.get("/y/")).not.toBeNull();
    a.close();
  });

  it("round-trips export/import as JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "hybld-mf-"));
    const m = fresh();
    m.upsert(row("/a/"));
    m.setMeta("lastBuildAt", "2026-07-03T00:00:00Z");
    const file = join(dir, "export.json");
    expect(m.exportJson(file)).toBe(1);
    const m2 = fresh();
    expect(m2.importJson(file)).toBe(1);
    expect(m2.get("/a/")?.contentHash).toBe("abc");
    expect(m2.getMeta("lastBuildAt")).toBe("2026-07-03T00:00:00Z");
    m.close();
    m2.close();
  });
});
