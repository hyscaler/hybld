import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ManifestRow } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  route TEXT PRIMARY KEY,
  page_type TEXT NOT NULL,
  article_id TEXT,
  slug TEXT,
  source_ref TEXT,
  dependents_ref TEXT,
  feed_ref TEXT,
  alternates_ref TEXT,
  content_hash TEXT,
  cms_modified_at TEXT,
  built_at TEXT NOT NULL,
  asset_graph_hash TEXT NOT NULL,
  output_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pages_article ON pages(article_id);
CREATE INDEX IF NOT EXISTS idx_pages_asset ON pages(asset_graph_hash);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS asset_graphs (hash TEXT PRIMARY KEY, files TEXT NOT NULL, recorded_at TEXT NOT NULL);
`;

function toRow(r: any): ManifestRow {
  return {
    route: r.route,
    pageType: r.page_type,
    articleId: r.article_id,
    slug: r.slug,
    sourceRef: r.source_ref,
    dependentsRef: r.dependents_ref ?? null,
    feedRef: r.feed_ref ?? null,
    alternatesRef: r.alternates_ref ?? null,
    contentHash: r.content_hash,
    cmsModifiedAt: r.cms_modified_at,
    builtAt: r.built_at,
    assetGraphHash: r.asset_graph_hash,
    outputPath: r.output_path,
  };
}

export class Manifest {
  private db: DatabaseSync;
  private upsertStmt: ReturnType<DatabaseSync["prepare"]>;
  private getStmt: ReturnType<DatabaseSync["prepare"]>;
  private inTxn = false;

  constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // WAL + NORMAL: an order of magnitude on write-heavy builds; safe with
    // hybld's single-writer model (the build lock).
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    // Migrations for manifests created before these columns existed.
    for (const col of ["dependents_ref", "feed_ref", "alternates_ref"]) {
      try {
        this.db.exec(`ALTER TABLE pages ADD COLUMN ${col} TEXT`);
      } catch {
        /* column already exists */
      }
    }
    // Hot statements, prepared once (per-call prepare costs real time at scale).
    this.upsertStmt = this.db.prepare(
      `INSERT INTO pages (route, page_type, article_id, slug, source_ref, dependents_ref, feed_ref, alternates_ref, content_hash, cms_modified_at, built_at, asset_graph_hash, output_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route) DO UPDATE SET
         page_type=excluded.page_type, article_id=excluded.article_id, slug=excluded.slug,
         source_ref=excluded.source_ref, dependents_ref=excluded.dependents_ref,
         feed_ref=excluded.feed_ref, alternates_ref=excluded.alternates_ref,
         content_hash=excluded.content_hash,
         cms_modified_at=excluded.cms_modified_at, built_at=excluded.built_at,
         asset_graph_hash=excluded.asset_graph_hash, output_path=excluded.output_path`
    );
    this.getStmt = this.db.prepare(`SELECT * FROM pages WHERE route = ?`);
  }

  /**
   * Batch mutations for one build run into a single transaction: page upserts
   * otherwise auto-commit (one fsync each), which dominates full-build time.
   * Crash mid-run rolls back cleanly; rebuilt pages are re-recorded on rerun.
   */
  begin(): void {
    if (this.inTxn) return;
    this.db.exec("BEGIN");
    this.inTxn = true;
  }

  commit(): void {
    if (!this.inTxn) return;
    this.db.exec("COMMIT");
    this.inTxn = false;
  }

  rollback(): void {
    if (!this.inTxn) return;
    this.db.exec("ROLLBACK");
    this.inTxn = false;
  }

  upsert(row: ManifestRow): void {
    this.upsertStmt
      .run(
        row.route,
        row.pageType,
        row.articleId === null ? null : String(row.articleId),
        row.slug,
        row.sourceRef,
        row.dependentsRef,
        row.feedRef,
        row.alternatesRef ?? null,
        row.contentHash,
        row.cmsModifiedAt,
        row.builtAt,
        row.assetGraphHash,
        row.outputPath
      );
  }

  /**
   * Record which asset files belong to an asset graph (for GC). Merged as a
   * union: delegated backends emit differently-named runtime files (e.g.
   * Next buildId chunks) on each run for the same source fingerprint, and all
   * of them are live.
   */
  recordAssetGraph(hash: string, files: string[]): void {
    const existing = this.db.prepare(`SELECT files FROM asset_graphs WHERE hash = ?`).get(hash) as any;
    const union = new Set<string>(existing ? JSON.parse(existing.files) : []);
    for (const f of files) union.add(f);
    this.db
      .prepare(`INSERT INTO asset_graphs (hash, files, recorded_at) VALUES (?, ?, ?) ON CONFLICT(hash) DO UPDATE SET files=excluded.files`)
      .run(hash, JSON.stringify([...union]), new Date().toISOString());
  }

  /** Asset graph hashes still referenced by at least one built page. */
  liveAssetGraphHashes(): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT asset_graph_hash AS h FROM pages`).all() as any[];
    return new Set(rows.map((r) => r.h));
  }

  /** Any one row of a page type (used to pad delegated batches). */
  firstRowOfType(pageType: string): ManifestRow | null {
    const r = this.db.prepare(`SELECT * FROM pages WHERE page_type = ? LIMIT 1`).get(pageType);
    return r ? toRow(r) : null;
  }

  /** Hashes that have a recorded file list. */
  recordedAssetHashes(): Set<string> {
    const rows = this.db.prepare(`SELECT hash FROM asset_graphs`).all() as any[];
    return new Set(rows.map((r) => r.hash));
  }

  assetGraphFiles(hashes: Set<string>): Set<string> {
    const keep = new Set<string>();
    for (const r of this.db.prepare(`SELECT hash, files FROM asset_graphs`).all() as any[]) {
      if (hashes.has(r.hash)) for (const f of JSON.parse(r.files)) keep.add(f);
    }
    return keep;
  }

  pruneAssetGraphs(live: Set<string>): number {
    let removed = 0;
    for (const r of this.db.prepare(`SELECT hash FROM asset_graphs`).all() as any[]) {
      if (!live.has(r.hash)) {
        this.db.prepare(`DELETE FROM asset_graphs WHERE hash = ?`).run(r.hash);
        removed++;
      }
    }
    return removed;
  }

  /** Feed entries: newest article rows that carry a feed_ref. */
  feedRows(limit: number): ManifestRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pages WHERE feed_ref IS NOT NULL ORDER BY COALESCE(cms_modified_at, built_at) DESC LIMIT ?`
      )
      .all(limit) as any[];
    return rows.map(toRow);
  }

  get(route: string): ManifestRow | null {
    const r = this.getStmt.get(route);
    return r ? toRow(r) : null;
  }

  byArticleId(id: string | number, pageType?: string): ManifestRow | null {
    const r = pageType
      ? this.db.prepare(`SELECT * FROM pages WHERE article_id = ? AND page_type = ?`).get(String(id), pageType)
      : this.db.prepare(`SELECT * FROM pages WHERE article_id = ?`).get(String(id));
    return r ? toRow(r) : null;
  }

  bySlug(slug: string, pageType?: string): ManifestRow | null {
    const r = pageType
      ? this.db.prepare(`SELECT * FROM pages WHERE slug = ? AND page_type = ?`).get(slug, pageType)
      : this.db.prepare(`SELECT * FROM pages WHERE slug = ?`).get(slug);
    return r ? toRow(r) : null;
  }

  remove(route: string): void {
    this.db.prepare(`DELETE FROM pages WHERE route = ?`).run(route);
  }

  all(): ManifestRow[] {
    return (this.db.prepare(`SELECT * FROM pages ORDER BY route`).all() as any[]).map(toRow);
  }

  routes(): Set<string> {
    const rows = this.db.prepare(`SELECT route FROM pages`).all() as any[];
    return new Set(rows.map((r) => r.route));
  }

  codeStale(currentHash: string, limit?: number): ManifestRow[] {
    const sql = `SELECT * FROM pages WHERE asset_graph_hash != ? ORDER BY built_at ASC${limit ? ` LIMIT ${Number(limit)}` : ""}`;
    return (this.db.prepare(sql).all(currentHash) as any[]).map(toRow);
  }

  counts(): { total: number; byPageType: Record<string, number> } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM pages`).get() as any).c as number;
    const rows = this.db.prepare(`SELECT page_type, COUNT(*) AS c FROM pages GROUP BY page_type`).all() as any[];
    const byPageType: Record<string, number> = {};
    for (const r of rows) byPageType[r.page_type] = r.c;
    return { total, byPageType };
  }

  codeStaleCount(currentHash: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS c FROM pages WHERE asset_graph_hash != ?`).get(currentHash) as any)
      .c as number;
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as any;
    return r ? r.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(key, value);
  }

  exportJson(file: string): number {
    const data = { version: 1, meta: this.allMeta(), pages: this.all() };
    writeFileSync(file, JSON.stringify(data, null, 2));
    return data.pages.length;
  }

  importJson(file: string): number {
    const data = JSON.parse(readFileSync(file, "utf8"));
    for (const [k, v] of Object.entries(data.meta ?? {})) this.setMeta(k, String(v));
    for (const row of data.pages ?? []) this.upsert(row);
    return (data.pages ?? []).length;
  }

  /** Merge another manifest db into this one; newest built_at wins per route. */
  merge(otherPath: string): number {
    const other = new Manifest(otherPath);
    let merged = 0;
    for (const row of other.all()) {
      const existing = this.get(row.route);
      if (!existing || existing.builtAt < row.builtAt) {
        this.upsert(row);
        merged++;
      }
    }
    for (const [k, v] of Object.entries(other.allMeta())) {
      const mine = this.getMeta(k);
      if (!mine || mine < v) this.setMeta(k, v);
    }
    other.close();
    return merged;
  }

  /**
   * Write a consistent snapshot of the database next to it (`<path>.bak`).
   * VACUUM INTO copies committed state only, so it is safe while the build
   * lock is held; the snapshot replaces the previous one atomically.
   */
  backup(): string {
    const dest = backupPathFor(this.path);
    const tmp = `${dest}.tmp-${process.pid}`;
    rmSync(tmp, { force: true });
    this.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    renameSync(tmp, dest);
    return dest;
  }

  allMeta(): Record<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM meta`).all() as any[];
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  close(): void {
    this.rollback();
    this.db.close();
  }
}

export function backupPathFor(manifestPath: string): string {
  return `${manifestPath}.bak`;
}

/**
 * If the manifest is missing or unreadable and a backup snapshot exists,
 * put the snapshot in its place. Returns what happened, or null when the
 * manifest was fine (or there was nothing to restore from). An unreadable
 * manifest is kept aside as `<path>.corrupt-<timestamp>`.
 */
export function restoreManifestIfLost(manifestPath: string): "missing" | "corrupt" | null {
  const backup = backupPathFor(manifestPath);
  if (!existsSync(backup)) return null;
  let reason: "missing" | "corrupt" | null = null;
  if (!existsSync(manifestPath)) {
    reason = "missing";
  } else {
    try {
      const probe = new DatabaseSync(manifestPath);
      try {
        probe.prepare("SELECT count(*) FROM sqlite_master").get();
      } finally {
        probe.close();
      }
    } catch {
      reason = "corrupt";
      renameSync(manifestPath, `${manifestPath}.corrupt-${Date.now()}`);
    }
  }
  if (!reason) return null;
  // Leftover WAL files belong to the lost database, not to the snapshot.
  rmSync(`${manifestPath}-wal`, { force: true });
  rmSync(`${manifestPath}-shm`, { force: true });
  mkdirSync(dirname(manifestPath), { recursive: true });
  copyFileSync(backup, manifestPath);
  return reason;
}
