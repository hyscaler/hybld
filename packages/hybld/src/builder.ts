import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import { createCmsHelper } from "./cms-helper.js";
import { writeFeed } from "./feed.js";
import { ImageLocalizer } from "./images.js";
import { BuildLock } from "./lock.js";
import { Manifest, restoreManifestIfLost } from "./manifest.js";
import { OutputWriter, routeToOutputPath } from "./output.js";
import { Redirects } from "./redirects.js";
import { writeSitemap } from "./sitemap.js";
import { DelegatedBackend } from "./backends/delegated.js";
import { reactVite } from "./backends/react-vite.js";
import type {
  AggregatePageConfig,
  Alternate,
  BuildOptions,
  BuildSummary,
  CmsAdapter,
  CollectionPageConfig,
  DependentRef,
  LoaderCtx,
  PageFailure,
  RenderBackend,
  RenderJob,
  RenderedPage,
  ResolvedConfig,
  StatusReport,
} from "./types.js";

const DEFAULT_ARCHIVE_DEPTH = 3;
const DEFAULT_COLLECTION = "article";

interface ArticleJob {
  kind: "article";
  route: string;
  article: any;
  collectionType: string;
  isDependent?: boolean;
  /** Delegated-mode padding/singleton jobs bypass content-hash skipping. */
  forceRender?: boolean;
}
interface AggregateJob {
  kind: "aggregate";
  route: string;
  pageType: string;
  item: any;
  page: number;
  isDependent?: boolean;
  forceRender?: boolean;
}
type Job = ArticleJob | AggregateJob;

interface Deletion {
  route: string;
  outputPath: string;
  dependentsRef: string | null;
}

interface EvaluatedJob {
  job: Job;
  renderJob: RenderJob;
  contentHash: string;
  articleId: string | null;
  slug: string | null;
  cmsModifiedAt: string | null;
  sourceRef: string | null;
  dependentsRef: string | null;
  feedRef: string | null;
  alternatesRef: string | null;
}

export interface CreateBuilderOptions {
  configFile?: string;
  cwd?: string;
  wait?: boolean;
  log?: (msg: string) => void;
  /** Vite plugin mode: the client build already ran; only the SSR build is performed (react-vite backend only). */
  externalClientBuild?: boolean;
}

export async function createBuilder(opts: CreateBuilderOptions = {}): Promise<Builder> {
  const cfg = await loadConfig(opts.configFile, opts.cwd);
  return new Builder(cfg, opts);
}

export class Builder {
  private manifest: Manifest;
  private backend: RenderBackend;
  private lock: BuildLock;
  private ctx: LoaderCtx;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<BuildSummary>>();
  private log: (msg: string) => void;
  private wait: boolean;
  private images: ImageLocalizer | null;

  constructor(
    public readonly config: ResolvedConfig,
    opts: CreateBuilderOptions = {}
  ) {
    // A lost or unreadable manifest would otherwise mean rebuilding the whole
    // site; fall back to the last backup snapshot and say so loudly.
    const restored = config.manifestBackup ? restoreManifestIfLost(config.manifest) : null;
    if (restored) {
      console.warn(
        `hybld: the manifest was ${restored}; restored it from ${config.manifest}.bak. ` +
          `Pages built after that snapshot are picked up again by the next "--since last-build" run. ` +
          `(To start from an empty manifest instead, delete the .bak file too.)`
      );
    }
    this.manifest = new Manifest(config.manifest);
    this.backend = (config.renderer ?? reactVite()).create(config, { externalClientBuild: opts.externalClientBuild });
    this.lock = new BuildLock(join(dirname(config.manifest), "build.lock"));
    this.ctx = { cms: createCmsHelper(config.adapter, { perPage: config.cms.perPage }) };
    this.log = opts.log ?? (() => {});
    this.wait = opts.wait ?? false;
    if (config.cms.cache) {
      (config.adapter as any).fetcher?.enableDiskCache?.({
        dir: join(dirname(config.manifest), "cache"),
        ttlMs: config.cms.cache.ttlSeconds * 1000,
      });
    }
    this.images = config.images
      ? new ImageLocalizer({
          origins: config.images.origins,
          dir: config.images.dir,
          outDir: config.outDir,
          fetcher: (config.adapter as any).fetcher,
          optimize: config.images.optimize ?? undefined,
        })
      : null;
  }

  get backendMode(): "owned" | "delegated" {
    return this.backend.mode;
  }

  // ---- page-type helpers -------------------------------------------------

  /** Adapter-backed collection page types: explicit `collection: true`, or the legacy "article" key. */
  private collections(): Array<[string, CollectionPageConfig]> {
    return Object.entries(this.config.pages)
      .filter(([name, p]) => {
        if (!p) return false;
        const cfg = p as any;
        return cfg.collection === true || (name === DEFAULT_COLLECTION && !cfg.enumerate);
      })
      .map(([name, p]) => [name, p as CollectionPageConfig]);
  }

  private collectionCfg(type: string): CollectionPageConfig {
    const found = this.collections().find(([name]) => name === type);
    if (!found) throw new Error(`"${type}" is not a collection page type in config.pages`);
    return found[1];
  }

  private adapterFor(type: string): CmsAdapter {
    return this.collectionCfg(type).adapter ?? this.config.adapter;
  }

  private idOf(type: string, a: any): string {
    const cfg = this.collectionCfg(type);
    return String(cfg.id ? cfg.id(a) : a.id);
  }
  private slugOf(type: string, a: any): string | null {
    const cfg = this.collectionCfg(type);
    return (cfg.slug ? cfg.slug(a) : a.slug) ?? null;
  }
  private modOf(type: string, a: any): string | null {
    const cfg = this.collectionCfg(type);
    return (cfg.modifiedAt ? cfg.modifiedAt(a) : (a.modified ?? a.modifiedAt ?? a.updatedAt ?? a.date)) ?? null;
  }

  private aggregateTypes(): Array<[string, AggregatePageConfig]> {
    const collectionNames = new Set(this.collections().map(([n]) => n));
    return Object.entries(this.config.pages)
      .filter(([name, p]) => p && !collectionNames.has(name))
      .map(([name, p]) => [name, p as AggregatePageConfig]);
  }

  // ---- build queue -------------------------------------------------------

  /** Queue + coalesce builds (FR-13/FR-15): identical queued requests share one run. */
  build(opts: BuildOptions = {}): Promise<BuildSummary> {
    const key = JSON.stringify(opts);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const run = this.chain.then(
      () => this.runBuild(opts),
      () => this.runBuild(opts)
    );
    this.chain = run.catch(() => {});
    this.pending.set(key, run);
    // then(onOk, onErr), NOT finally(): finally() derives a promise that
    // re-rejects on failure, and that orphan rejection would crash the
    // process (serve mode) even when the caller handles the returned one.
    run.then(
      () => this.pending.delete(key),
      () => this.pending.delete(key)
    );
    return run;
  }

  private async runBuild(opts: BuildOptions): Promise<BuildSummary> {
    const t0 = Date.now();
    const mode = describeMode(opts);
    // clean empties the cumulative outDir; combined with a narrow scope it
    // would leave the deployed site with only the scoped pages (same footgun
    // the Vite plugin guards against).
    if (opts.clean && !opts.all) {
      throw new Error(
        "--clean empties the output directory and may only be combined with --all: " +
          "a clean followed by a narrow scope would leave the site with only the scoped pages."
      );
    }
    await this.lock.acquire(this.wait);
    try {
      this.log(`build (${mode}) starting [backend: ${this.backend.name}]`);
      (this.config.adapter as any).fetcher?.clearMemo?.();
      for (const [, c] of this.collections()) (c.adapter as any)?.fetcher?.clearMemo?.();
      await this.images?.init();
      await this.backend.prepare({ clean: opts.clean ?? false });
      const assetHash = this.backend.assetGraphHash;

      const summary: BuildSummary = {
        mode,
        built: [],
        skipped: [],
        failed: [],
        deleted: [],
        moved: [],
        dependentsRebuilt: [],
        cmsRequests: 0,
        durationMs: 0,
        assetGraphHash: assetHash,
      };

      // A previous run may have committed its manifest but crashed before its
      // deferred file removals ran; finish them now (see journal notes below).
      this.replayRemovalJournal();

      const { jobs, deletions } = await this.resolveScope(opts, assetHash, summary);

      // Dependents are resolved BEFORE rendering so delegated backends run a
      // single framework build per run, never one for pages + one for deps.
      let allJobs = [...jobs];
      if (!opts.noDependents) {
        const depJobs = await this.resolveDependents(jobs, deletions, summary);
        const have = new Set(jobs.map((j) => j.route));
        allJobs.push(...depJobs.filter((j) => !have.has(j.route)));
      }
      // Delegated: singleton aggregates (home, 404) are static framework
      // routes rebuilt on EVERY framework run, so their data must ride along
      // in every batch's scope file (the page reads it via hybldData) and
      // their manifest rows should stay fresh. Additionally, every dynamic
      // route type needs at least one entry in the batch: Next's static
      // export refuses a generateStaticParams that returns an empty list, so
      // empty types are padded with one already-built page from the manifest.
      if (this.backend.mode === "delegated" && allJobs.length > 0) {
        const have = new Set(allJobs.map((j) => j.route));
        for (const [name, page] of this.aggregateTypes()) {
          if (page.enumerate) continue;
          const route = page.route();
          if (!have.has(route)) {
            allJobs.push({ kind: "aggregate", route, pageType: name, item: null, page: 1, isDependent: true, forceRender: true });
          }
        }
        for (const job of allJobs) {
          if (job.kind === "aggregate" && !(this.config.pages[job.pageType] as AggregatePageConfig | undefined)?.enumerate) {
            job.forceRender = true;
          }
        }
        const presentTypes = new Set(allJobs.map((j) => (j.kind === "article" ? j.collectionType : j.pageType)));
        allJobs.push(...(await this.paddingJobs(presentTypes)));
      }

      if (opts.dryRun) {
        summary.dryRun = true;
        summary.plannedRoutes = allJobs.map((j) => j.route);
        summary.deleted = deletions.map((d) => d.route);
        summary.durationMs = Date.now() - t0;
        return summary;
      }

      // One transaction per run: page upserts would otherwise fsync per row,
      // which dominates full-build time at scale.
      this.manifest.begin();

      const writer = new OutputWriter(this.config.outDir);
      const redirects = new Redirects(this.config.redirects.file);
      // File removals (moves, deletions) are collected here and executed only
      // AFTER the manifest commit: rmSync inside the transaction window is not
      // rolled back on crash, which would leave manifest rows pointing at
      // files that no longer exist.
      const pendingRemovals: string[] = [];

      // Moves (FR-17), detected against the manifest per collection.
      for (const job of allJobs) {
        if (job.kind !== "article") continue;
        const row = this.manifest.byArticleId(this.idOf(job.collectionType, job.article), job.collectionType);
        if (row && row.route !== job.route) {
          summary.moved.push({ from: row.route, to: job.route });
          redirects.addMove(row.route, job.route);
          pendingRemovals.push(...this.pageFilesOf(row.outputPath));
          this.manifest.remove(row.route);
        }
      }

      // Phase 1: evaluate (fetch data, hash, skip decision). Engine-side, identical for both strategies.
      const evaluated: EvaluatedJob[] = [];
      await mapLimit(allJobs, opts.concurrency ?? this.config.render.workers, async (job) => {
        try {
          evaluated.push(await this.evaluateJob(job));
        } catch (err: any) {
          summary.failed.push({ route: job.route, error: err?.message ?? String(err) });
          if (opts.failFast) throw err;
        }
      });
      // Force re-render when the file is missing or the asset graph moved on.
      // Delegated singleton/padding jobs always render: the framework needs
      // their scope entries in every run.
      const freshSkipped: EvaluatedJob[] = [];
      const toRender = evaluated.filter((ev) => {
        if (ev.job.forceRender) return true;
        const existing = this.manifest.get(ev.job.route);
        const fresh =
          !opts.force &&
          existing &&
          existing.contentHash === ev.contentHash &&
          existing.assetGraphHash === assetHash &&
          existsSync(join(this.config.outDir, existing.outputPath));
        if (fresh) freshSkipped.push(ev);
        // Manifest recovery: a page with no manifest row whose output file is
        // already on disk is recorded as built instead of rendered again.
        if (!fresh && opts.adopt && !existing) {
          const outputPath = this.existingOutputFor(ev.job.route);
          if (outputPath) {
            this.upsertFromEvaluated(ev, assetHash, outputPath);
            summary.adopted = (summary.adopted ?? 0) + 1;
            freshSkipped.push(ev);
            return false;
          }
        }
        return !fresh;
      });
      // Delegated: freshness-skipping must not empty a dynamic route type out
      // of the batch (batch padding ran before this filter, and Next's export
      // refuses an empty generateStaticParams). Promote one fresh page per
      // emptied type back in; the unchanged-content check after render still
      // reports it as skipped.
      if (this.backend.mode === "delegated" && toRender.length > 0) {
        const present = new Set(toRender.map((ev) => ev.renderJob.pageType));
        for (const ev of freshSkipped) {
          if (!present.has(ev.renderJob.pageType)) {
            present.add(ev.renderJob.pageType);
            ev.job.forceRender = true;
            toRender.push(ev);
          } else {
            summary.skipped.push(ev.job.route);
          }
        }
      } else {
        for (const ev of freshSkipped) summary.skipped.push(ev.job.route);
      }

      // Phase 2: render through the backend and write as results land. The
      // owned backend renders in bounded slices so a large scope never holds
      // every page's HTML in memory at once (and completed slices survive a
      // late crash); delegated backends get the whole scope in ONE framework
      // build by default. With render.batchSize (or --batch-size) a large
      // delegated scope is split into several framework builds, each padded
      // so every page type stays present, and the manifest is checkpointed
      // between batches so a crash late in a long first build keeps the
      // batches already merged.
      const RENDER_SLICE = 500;
      const delegated = this.backend.mode === "delegated";
      const batchSize = opts.batchSize ?? this.config.render.batchSize;
      const sliceSize = delegated ? Math.max(1, batchSize ?? toRender.length) : RENDER_SLICE;
      const slices: EvaluatedJob[][] = [];
      if (toRender.length === 0) slices.push([]);
      for (let i = 0; i < toRender.length; i += sliceSize) slices.push(toRender.slice(i, i + sliceSize));
      if (delegated && slices.length > 1) {
        const firstOfType = new Map<string, EvaluatedJob>();
        for (const ev of toRender) {
          if (!firstOfType.has(ev.renderJob.pageType)) firstOfType.set(ev.renderJob.pageType, ev);
        }
        for (const slice of slices) {
          const present = new Set(slice.map((ev) => ev.renderJob.pageType));
          for (const [type, ev] of firstOfType) if (!present.has(type)) slice.push(ev);
        }
      }
      const handled = new Set<string>();
      const assetFilesSeen = new Set<string>();
      for (const [sliceIndex, slice] of slices.entries()) {
        const lastSlice = sliceIndex === slices.length - 1;
        if (slices.length > 1) this.log(`render batch ${sliceIndex + 1}/${slices.length} (${slice.length} pages)`);
        const results = await this.backend.renderBatch(slice.map((ev) => ev.renderJob));
        const byRoute = new Map(slice.map((ev) => [ev.job.route, ev]));
        for (const result of results) {
          const ev = byRoute.get(result.route);
          // A padding page rides in several batches; record it once.
          if (result.kind !== "extra") {
            if (handled.has(result.route)) continue;
            handled.add(result.route);
          }
          try {
            if (result.kind === "failed") {
              summary.failed.push({ route: result.route, error: result.error });
              if (opts.failFast) throw new Error(result.error);
              continue;
            }
            if (result.kind === "extra") {
              await this.mergeExtra(result, assetHash, writer);
              continue;
            }
            if (!ev) continue;
            // Padding/singleton jobs re-render on every delegated run by
            // necessity; when nothing about them changed, report them as
            // skipped so no-op runs don't look like content changes (and
            // don't force sitemap/feed regeneration).
            const before = ev.job.forceRender ? this.manifest.get(result.route) : undefined;
            const unchanged =
              Boolean(before) && before!.contentHash === ev.contentHash && before!.assetGraphHash === assetHash;
            if (result.kind === "html") {
              await this.writeOwnedPage(ev, result.html, assetHash, writer);
            } else {
              await this.mergeDelegatedPage(ev, result, assetHash, writer);
            }
            if (unchanged) {
              summary.skipped.push(result.route);
            } else {
              summary.built.push(result.route);
              if (ev.job.isDependent) summary.dependentsRebuilt.push(result.route);
            }
          } catch (err: any) {
            summary.failed.push({ route: result.route, error: err?.message ?? String(err) });
            if (opts.failFast) throw err;
          }
        }

        // The framework's staging dir is replaced by the next batch's build,
        // so everything below merges per batch.
        // Delegated: merge the framework's hashed assets append-only.
        if (this.backend instanceof DelegatedBackend) {
          for (const { absPath, relPath } of this.backend.stagedAssetFiles()) {
            const target = join(this.config.outDir, relPath);
            if (!existsSync(target)) {
              mkdirSync(dirname(target), { recursive: true });
              copyFileSync(absPath, target);
              writer.created.push(relPath);
            }
          }
          // Non-page, non-asset outputs (public/ files, robots.txt, favicons,
          // rss.xml): overwrite-copy, since these are unhashed and can change
          // without renaming. Byte-compare keeps the changed-files report honest.
          for (const { absPath, relPath } of this.backend.stagedStaticFiles()) {
            const target = join(this.config.outDir, relPath);
            const src = readFileSync(absPath);
            if (existsSync(target)) {
              if (src.equals(readFileSync(target))) continue;
              copyFileSync(absPath, target);
              writer.updated.push(relPath);
            } else {
              mkdirSync(dirname(target), { recursive: true });
              copyFileSync(absPath, target);
              writer.created.push(relPath);
            }
          }
        }
        for (const file of this.backend.assetFiles) assetFilesSeen.add(file);

        // Backend post-merge housekeeping (e.g. Next Pages Router data JSON
        // fan-out/pruning); its removals join the run's deferred deletions.
        // Deletions are handed over once, with the last batch.
        if (this.backend.finalizeMerge) {
          const fin = this.backend.finalizeMerge({
            deletedPageOutputs: lastSlice ? deletions.map((d) => d.outputPath) : [],
          });
          writer.created.push(...fin.created);
          writer.updated.push(...fin.updated);
          pendingRemovals.push(...fin.removals);
        }

        // Checkpoint: make the batches merged so far durable. Only when no
        // file removals are pending, since those are journaled against the
        // run's final commit. The flag forces sitemap/feed regeneration if
        // the run dies after its last checkpoint.
        if (!lastSlice && pendingRemovals.length === 0) {
          this.manifest.setMeta("runIncomplete", "1");
          this.manifest.commit();
          this.manifest.begin();
        }
      }
      if (assetFilesSeen.size > 0) {
        this.manifest.recordAssetGraph(assetHash, [...assetFilesSeen]);
      }

      // Deletions (FR-9): manifest rows go now (inside the txn), files after commit.
      for (const del of deletions) {
        pendingRemovals.push(...this.pageFilesOf(del.outputPath));
        this.manifest.remove(del.route);
        summary.deleted.push(del.route);
      }

      // Sitemap and feed derive purely from the page set; skip both when it
      // did not change (all-skip sweeps stay cheap at large catalogs).
      const resumedRun = this.manifest.getMeta("runIncomplete") === "1";
      const pageSetChanged =
        resumedRun || (summary.adopted ?? 0) > 0 || summary.built.length + summary.deleted.length + summary.moved.length > 0;
      if (resumedRun) this.manifest.setMeta("runIncomplete", "");
      if (pageSetChanged && this.config.sitemap.enabled) {
        if (!this.config.sitemap.baseUrl) throw new Error("sitemap.baseUrl is required when sitemap.enabled is true");
        writeSitemap(this.manifest, writer, this.config.sitemap.baseUrl);
      }
      if (pageSetChanged && this.config.feed.enabled) {
        writeFeed(this.manifest, writer, this.config.feed);
      }
      redirects.save();

      // The incremental cursor only advances on runs that actually processed
      // every modification since the last cursor (--all lists the whole
      // catalog; --since queries listModifiedSince). A targeted/chunk/limit
      // build in between must not advance it, or the next `--since last-build`
      // skips updates it never saw. Reconcile is explicitly excluded: it does
      // a full ID sweep for DELETIONS but never processes modified articles,
      // so advancing the cursor would skip everything modified since the last
      // real --since run. Failed pages also hold the cursor back so they retry.
      const coversCatalog = Boolean(opts.all) || opts.since !== undefined;
      if (coversCatalog && summary.failed.length === 0) {
        this.manifest.setMeta("lastBuildAt", new Date(t0).toISOString());
      }
      if (opts.all) this.manifest.setMeta("lastFullBuildAt", new Date(t0).toISOString());
      this.manifest.setMeta("assetGraphHash", assetHash);

      // Journal the deferred removals inside the txn (token ties the journal
      // to THIS commit; a rolled-back run's journal is discarded on replay).
      const removalToken = randomUUID();
      if (pendingRemovals.length > 0) {
        this.manifest.setMeta("pendingRemovalsToken", removalToken);
        writeFileSync(this.removalJournalPath(), JSON.stringify({ token: removalToken, paths: pendingRemovals }));
      }
      this.manifest.commit();

      // Execute removals now that the manifest is durable. Skip anything this
      // run (re)wrote: a swap-move (A: /x -> /y, B: /y -> /x) queues removal
      // of paths that now hold fresh pages.
      if (pendingRemovals.length > 0) {
        const written = new Set([...writer.created, ...writer.updated]);
        for (const path of pendingRemovals) {
          if (!written.has(path)) writer.deletePage(path);
        }
        rmSync(this.removalJournalPath(), { force: true });
        this.manifest.setMeta("pendingRemovalsToken", "");
      }

      if (pageSetChanged) this.backupManifestIfDue();

      if (this.images) writer.created.push(...this.images.drainNewFiles());
      summary.cmsRequests = (this.config.adapter as any).fetcher?.requestCount?.() ?? 0;
      summary.durationMs = Date.now() - t0;
      summary.reportPath = this.writeReport(summary, writer);
      this.log(`build (${mode}) done: ${summary.built.length} built, ${summary.skipped.length} skipped`);
      return summary;
    } finally {
      this.manifest.rollback(); // no-op after a successful commit
      this.lock.release();
      // Release the run's memoized CMS responses. Clearing only at the START
      // of the next run would leave a long-lived process (serve mode) holding
      // the entire last catalog sweep in memory while idle.
      (this.config.adapter as any).fetcher?.clearMemo?.();
      for (const [, c] of this.collections()) (c.adapter as any)?.fetcher?.clearMemo?.();
    }
  }

  /**
   * One forced job per dynamic page type missing from a delegated batch:
   * Next's static export refuses a generateStaticParams that returns nothing.
   * Prefers an already-built page; on a fresh manifest falls back to one live
   * item.
   */
  private async paddingJobs(presentTypes: Set<string>): Promise<Job[]> {
    const out: Job[] = [];
    for (const [name] of this.collections()) {
      if (presentTypes.has(name)) continue;
      // Prefer an already-built page; on a fresh manifest (first chunked or
      // targeted build) fall back to one live item so Next's export never
      // sees an empty generateStaticParams.
      const row = this.manifest.firstRowOfType(name);
      let article = row?.articleId ? await this.adapterFor(name).getArticle({ id: row.articleId }) : null;
      if (!article) {
        const res = await this.adapterFor(name).listArticles({ page: 1, perPage: 1 });
        article = res.items[0] ?? null;
      }
      if (article) {
        out.push({
          kind: "article",
          route: this.collectionCfg(name).route(article),
          article,
          collectionType: name,
          forceRender: true,
        });
      }
    }
    for (const [name, page] of this.aggregateTypes()) {
      if (!page.enumerate || presentTypes.has(name)) continue;
      const row = this.manifest.firstRowOfType(name);
      if (row?.sourceRef) {
        const ref = JSON.parse(row.sourceRef);
        out.push({ kind: "aggregate", route: row.route, pageType: name, item: ref.item, page: ref.page, forceRender: true });
        continue;
      }
      const items = await page.enumerate(this.ctx);
      if (items[0] !== undefined) {
        out.push({ kind: "aggregate", route: page.route(items[0], 1), pageType: name, item: items[0], page: 1, forceRender: true });
      }
    }
    return out;
  }

  /** The output file a route already has on disk (relative to outDir), if any. */
  private existingOutputFor(route: string): string | null {
    const candidates =
      this.backend instanceof DelegatedBackend ? this.backend.outputCandidates(route) : [routeToOutputPath(route)];
    return candidates.find((rel) => existsSync(join(this.config.outDir, rel))) ?? null;
  }

  /** Snapshot the manifest when backups are on and the last one is old enough. Never fails a build. */
  private backupManifestIfDue(force = false): string | null {
    const cfg = this.config.manifestBackup;
    if (!cfg && !force) return null;
    const last = Date.parse(this.manifest.getMeta("lastBackupAt") ?? "");
    const due = force || Number.isNaN(last) || Date.now() - last >= (cfg?.everyMinutes ?? 0) * 60_000;
    if (!due) return null;
    try {
      this.manifest.setMeta("lastBackupAt", new Date().toISOString());
      return this.manifest.backup();
    } catch (err: any) {
      this.log(`manifest backup failed: ${err?.message ?? err}`);
      return null;
    }
  }

  /** Write a manifest snapshot now (`hybld manifest backup`). */
  backupManifest(): string | null {
    return this.backupManifestIfDue(true);
  }

  // ---- job evaluation and output -----------------------------------------

  private async evaluateJob(job: Job): Promise<EvaluatedJob> {
    let data: any;
    let articleId: string | null = null;
    let slug: string | null = null;
    let cmsModifiedAt: string | null = null;
    let sourceRef: string | null = null;
    let dependentsRef: string | null = null;
    let feedRef: string | null = null;
    let alternates: Alternate[] | undefined;

    if (job.kind === "article") {
      const cfg = this.collectionCfg(job.collectionType);
      data = await cfg.data(job.article);
      articleId = this.idOf(job.collectionType, job.article);
      slug = this.slugOf(job.collectionType, job.article);
      cmsModifiedAt = this.modOf(job.collectionType, job.article);
      const deps = cfg.dependents?.(job.article);
      dependentsRef = deps?.length ? JSON.stringify(deps) : null;
      const alts = cfg.alternates?.(job.article);
      if (alts?.length) alternates = alts.map((a) => ({ lang: String(a.lang), route: String(a.route) }));
      if (this.config.feed.enabled) {
        const item = this.config.feed.item ? this.config.feed.item(job.article) : defaultFeedItem(job.article);
        feedRef = JSON.stringify(item);
      }
    } else {
      const page = this.config.pages[job.pageType] as AggregatePageConfig;
      data = page.enumerate ? await page.data(job.item, job.page, this.ctx) : await page.data(this.ctx);
      sourceRef = JSON.stringify({ item: job.item, page: job.page });
    }

    // Alternates feed the page's hreflang tags, so a new translation must
    // rebuild the page; pages without alternates keep their existing hashes.
    const hashInput = alternates ? stableStringify({ data, alternates }) : stableStringify(data);
    const contentHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 12);
    const pageType = job.kind === "article" ? job.collectionType : job.pageType;
    return {
      job,
      contentHash,
      articleId,
      slug,
      cmsModifiedAt,
      sourceRef,
      dependentsRef,
      feedRef,
      alternatesRef: alternates ? JSON.stringify(alternates) : null,
      renderJob: {
        route: job.route,
        pageType,
        data,
        article: job.kind === "article" ? job.article : undefined,
        slug,
        id: articleId,
        item: job.kind === "aggregate" ? job.item : undefined,
        page: job.kind === "aggregate" ? job.page : undefined,
        alternates,
      },
    };
  }

  private async writeOwnedPage(ev: EvaluatedJob, html: string, assetHash: string, writer: OutputWriter): Promise<void> {
    if (this.images) html = (await this.images.localizeHtml(html)).html;
    const outputPath = routeToOutputPath(ev.job.route);
    writer.writePage(outputPath, html);
    if (this.config.emitData) {
      writer.writePage(dataPathFor(outputPath), JSON.stringify({ route: ev.job.route, pageType: ev.renderJob.pageType, data: ev.renderJob.data }));
    }
    this.upsertFromEvaluated(ev, assetHash, outputPath);
  }

  private async mergeDelegatedPage(
    ev: EvaluatedJob,
    result: Extract<RenderedPage, { kind: "files" }>,
    assetHash: string,
    writer: OutputWriter
  ): Promise<void> {
    // Process the HTML first so image mappings are discovered, then apply the
    // same mappings to framework sidecars (RSC payloads escape quotes, so the
    // src/href regex cannot discover URLs there).
    const ordered = [...result.files].sort((a, b) => Number(b.relPath.endsWith(".html")) - Number(a.relPath.endsWith(".html")));
    for (const file of ordered) {
      let content = readFileSync(file.absPath, "utf8");
      if (this.images) {
        if (file.relPath.endsWith(".html")) content = (await this.images.localizeHtml(content)).html;
        else content = this.images.applyKnownMappings(content);
      }
      writer.writePage(file.relPath, content);
    }
    if (this.config.emitData) {
      writer.writePage(dataPathFor(result.outputPath), JSON.stringify({ route: ev.job.route, pageType: ev.renderJob.pageType, data: ev.renderJob.data }));
    }
    this.upsertFromEvaluated(ev, assetHash, result.outputPath);
  }

  /** Merge a page the framework emitted beyond the requested scope (static routes like home/404). */
  private async mergeExtra(
    result: Extract<RenderedPage, { kind: "extra" }>,
    assetHash: string,
    writer: OutputWriter
  ): Promise<void> {
    let primary = "";
    for (const file of result.files) {
      let content = readFileSync(file.absPath, "utf8");
      if (this.images) {
        if (file.relPath.endsWith(".html")) content = (await this.images.localizeHtml(content)).html;
        else content = this.images.applyKnownMappings(content);
      }
      if (file.relPath === result.outputPath) primary = content;
      writer.writePage(file.relPath, content);
    }
    const existing = this.manifest.get(result.route);
    this.manifest.upsert({
      route: result.route,
      pageType: existing?.pageType ?? "static",
      articleId: existing?.articleId ?? null,
      slug: existing?.slug ?? null,
      sourceRef: existing?.sourceRef ?? null,
      dependentsRef: existing?.dependentsRef ?? null,
      feedRef: existing?.feedRef ?? null,
      alternatesRef: existing?.alternatesRef ?? null,
      contentHash: createHash("sha256").update(primary).digest("hex").slice(0, 12),
      cmsModifiedAt: existing?.cmsModifiedAt ?? null,
      builtAt: new Date().toISOString(),
      assetGraphHash: assetHash,
      outputPath: result.outputPath,
    });
  }

  private upsertFromEvaluated(ev: EvaluatedJob, assetHash: string, outputPath: string): void {
    this.manifest.upsert({
      route: ev.job.route,
      pageType: ev.renderJob.pageType,
      articleId: ev.articleId,
      slug: ev.slug,
      sourceRef: ev.sourceRef,
      dependentsRef: ev.dependentsRef,
      feedRef: ev.feedRef,
      alternatesRef: ev.alternatesRef,
      contentHash: ev.contentHash,
      cmsModifiedAt: ev.cmsModifiedAt,
      builtAt: new Date().toISOString(),
      assetGraphHash: assetHash,
      outputPath,
    });
  }

  // ---- scope resolution ----------------------------------------------------

  private async resolveScope(
    opts: BuildOptions,
    assetHash: string,
    summary: BuildSummary
  ): Promise<{ jobs: Job[]; deletions: Deletion[] }> {
    const jobs = new Map<string, Job>();
    const deletions: Deletion[] = [];
    const addArticleJob = (type: string, article: any) => {
      const route = this.collectionCfg(type).route(article);
      jobs.set(route, { kind: "article", route, article, collectionType: type });
    };
    // Catalog listing: parallel page fetches (bounded by cms.concurrency)
    // when the adapter can report a count; serial round-trips otherwise.
    const listAll = async (type: string): Promise<any[]> => {
      const adapter = this.adapterFor(type);
      const perPage = this.config.cms.perPage;
      try {
        const total = await adapter.count();
        const pageCount = Math.max(1, Math.ceil(total / perPage));
        const chunks: any[][] = new Array(pageCount);
        await mapLimit(
          Array.from({ length: pageCount }, (_, i) => i + 1),
          this.config.cms.concurrency,
          async (page) => {
            chunks[page - 1] = (await adapter.listArticles({ page, perPage })).items;
          }
        );
        return chunks.flat();
      } catch {
        /* count() unsupported or failed: fall back to serial pagination */
      }
      const out: any[] = [];
      const guard = pageLoopGuard(adapter.name);
      for (let page = 1; ; page++) {
        const res = await adapter.listArticles({ page, perPage });
        guard(res.items, page);
        out.push(...res.items);
        if (!res.hasMore || res.items.length === 0) break;
      }
      return out;
    };

    if (opts.all || opts.limit !== undefined) {
      // --limit is a global bound, not per collection.
      let fetched = 0;
      for (const [type] of this.collections()) {
        if (opts.limit !== undefined) {
          if (fetched >= opts.limit) break;
          // Bounded fetch: serial with early exit.
          const adapter = this.adapterFor(type);
          const guard = pageLoopGuard(adapter.name);
          for (let page = 1; ; page++) {
            const res = await adapter.listArticles({ page, perPage: this.config.cms.perPage });
            guard(res.items, page);
            for (const a of res.items) {
              if (fetched >= opts.limit) break;
              addArticleJob(type, a);
              fetched++;
            }
            if (!res.hasMore || res.items.length === 0 || fetched >= opts.limit) break;
          }
        } else {
          for (const a of await listAll(type)) addArticleJob(type, a);
        }
      }
      for (const job of await this.allAggregateJobs()) jobs.set(job.route, job);
    } else if ((opts.chunk || opts.chunkSize !== undefined) && !opts.stale) {
      const catalog: Array<{ type: string; article: any }> = [];
      for (const [type] of this.collections()) {
        for (const a of await listAll(type)) catalog.push({ type, article: a });
      }
      // Canonical order so every --chunk i/n worker partitions identically
      // regardless of CMS fetch order. String/UUID ids must not go through
      // Number(): NaN comparators make the sort a no-op and shard membership
      // then depends on fetch order (duplicate and missing pages across workers).
      catalog.sort((a, b) => {
        const t = a.type.localeCompare(b.type);
        if (t !== 0) return t;
        const ia = this.idOf(a.type, a.article);
        const ib = this.idOf(b.type, b.article);
        const na = Number(ia);
        const nb = Number(ib);
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return ia < ib ? -1 : ia > ib ? 1 : 0;
      });
      if (opts.chunk) {
        const size = Math.ceil(catalog.length / opts.chunk.total);
        catalog
          .slice((opts.chunk.index - 1) * size, opts.chunk.index * size)
          .forEach(({ type, article }) => addArticleJob(type, article));
      } else {
        const known = this.manifest.routes();
        let taken = 0;
        for (const { type, article } of catalog) {
          if (taken >= (opts.chunkSize as number)) break;
          const route = this.collectionCfg(type).route(article);
          if (known.has(route)) continue;
          addArticleJob(type, article);
          taken++;
        }
      }
    } else if (opts.stale) {
      for (const job of await this.staleJobs(assetHash, opts.chunkSize)) jobs.set(job.route, job);
    } else if (opts.routes?.length || opts.slugs?.length || opts.ids?.length) {
      const resolveTargets = async (raw: Array<string | number>, by: "slug" | "id") => {
        for (const target of raw) {
          const { type, value } = parseTargetRef(String(target), this.collections().map(([n]) => n));
          const adapter = this.adapterFor(type);
          const article = await adapter.getArticle(by === "slug" ? { slug: value } : { id: value });
          if (article) addArticleJob(type, article);
          else summary.failed.push({ route: `${by}:${target}`, error: `${type} not found in CMS` });
        }
      };
      await resolveTargets(opts.slugs ?? [], "slug");
      await resolveTargets(opts.ids ?? [], "id");
      for (const route of opts.routes ?? []) {
        const job = await this.jobForRoute(route);
        if (typeof job === "string") summary.failed.push({ route, error: job });
        else jobs.set(job.route, job);
      }
    } else if (opts.since !== undefined) {
      const since = this.resolveSince(opts.since);
      let anySupport = false;
      for (const [type] of this.collections()) {
        const adapter = this.adapterFor(type);
        if (!adapter.listModifiedSince) continue;
        anySupport = true;
        const guard = pageLoopGuard(adapter.name);
        for (let page = 1; ; page++) {
          const res = await adapter.listModifiedSince(since, { page, perPage: this.config.cms.perPage });
          guard(res.items, page);
          res.items.forEach((a) => addArticleJob(type, a));
          if (!res.hasMore || res.items.length === 0) break;
        }
        if (adapter.listDeletedSince) {
          for (const ref of await adapter.listDeletedSince(since)) {
            const row =
              ref.id !== undefined
                ? this.manifest.byArticleId(ref.id, type)
                : ref.slug
                  ? this.manifest.bySlug(ref.slug, type)
                  : null;
            if (row) deletions.push({ route: row.route, outputPath: row.outputPath, dependentsRef: row.dependentsRef });
          }
        }
      }
      if (!anySupport) {
        throw new Error(
          `No collection adapter implements listModifiedSince(); --since is unavailable. Use targeted builds or a full build instead.`
        );
      }
    } else if (opts.reconcile) {
      // Prune: full ID sweep, then delete every manifest page whose article is
      // gone from the CMS. This is the deletion path for adapters without
      // listDeletedSince (dependents rebuild and sitemap/feed refresh included).
      for (const row of await this.orphanRows()) {
        deletions.push({ route: row.route, outputPath: row.outputPath, dependentsRef: row.dependentsRef });
      }
    } else {
      throw new Error(
        "No build scope given. Use --all, --limit, --chunk, --chunk-size, --routes/--slugs/--ids, --since, --stale or reconcile."
      );
    }

    return { jobs: [...jobs.values()], deletions };
  }

  private resolveSince(value: string): Date {
    if (value === "last-build") {
      const last = this.manifest.getMeta("lastBuildAt");
      if (!last) throw new Error(`--since last-build requires a previous build; none found in the manifest.`);
      return new Date(last);
    }
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid --since date: ${value}`);
    return d;
  }

  private async staleJobs(assetHash: string, limit?: number): Promise<Job[]> {
    const rows = this.manifest.codeStale(assetHash, limit);
    const collectionNames = new Set(this.collections().map(([n]) => n));
    const jobs: Job[] = [];
    for (const row of rows) {
      if (collectionNames.has(row.pageType)) {
        if (!row.articleId) continue;
        const article = await this.adapterFor(row.pageType).getArticle({ id: row.articleId });
        if (article) {
          jobs.push({ kind: "article", route: this.collectionCfg(row.pageType).route(article), article, collectionType: row.pageType });
        }
      } else if (row.sourceRef) {
        const ref = JSON.parse(row.sourceRef);
        jobs.push({ kind: "aggregate", route: row.route, pageType: row.pageType, item: ref.item, page: ref.page });
      }
    }
    return jobs;
  }

  private async jobForRoute(route: string): Promise<Job | string> {
    const row = this.manifest.get(route);
    const collectionNames = new Set(this.collections().map(([n]) => n));
    if (row) {
      if (collectionNames.has(row.pageType)) {
        if (!row.articleId) return "manifest row has no article id";
        const article = await this.adapterFor(row.pageType).getArticle({ id: row.articleId });
        if (!article) return "article no longer exists in CMS (use --since to process deletions)";
        return { kind: "article", route: this.collectionCfg(row.pageType).route(article), article, collectionType: row.pageType };
      }
      if (row.sourceRef) {
        const ref = JSON.parse(row.sourceRef);
        return { kind: "aggregate", route, pageType: row.pageType, item: ref.item, page: ref.page };
      }
      return "manifest row is missing its source reference";
    }
    for (const [name, page] of this.aggregateTypes()) {
      if (!page.enumerate && page.route() === route) {
        return { kind: "aggregate", route, pageType: name, item: null, page: 1 };
      }
    }
    // Never built: try collection match hooks (also used by serve regen).
    for (const [name, cfg] of this.collections()) {
      const ref = cfg.match?.(route);
      if (ref) {
        const article = await this.adapterFor(name).getArticle(ref);
        if (article) return { kind: "article", route: cfg.route(article), article, collectionType: name };
      }
    }
    return "route not found in manifest (build it via --slugs/--ids or --all first)";
  }

  /** Pages of a paginated aggregate: explicit pageCount hook, else derived from item.count. */
  private async pageCountOf(page: AggregatePageConfig, item: any): Promise<number> {
    if (page.pageCount) return Math.max(1, await page.pageCount(item, this.ctx));
    if (page.paginate && typeof item?.count === "number") {
      return Math.max(1, Math.ceil(item.count / page.paginate.perPage));
    }
    return 1;
  }

  private async allAggregateJobs(): Promise<AggregateJob[]> {
    const out: AggregateJob[] = [];
    for (const [name, page] of this.aggregateTypes()) {
      if (!page.enumerate) {
        out.push({ kind: "aggregate", route: page.route(), pageType: name, item: null, page: 1 });
        continue;
      }
      const items = await page.enumerate(this.ctx);
      for (const item of items) {
        const pageCount = await this.pageCountOf(page, item);
        for (let p = 1; p <= pageCount; p++) {
          out.push({ kind: "aggregate", route: page.route(item, p), pageType: name, item, page: p });
        }
      }
    }
    return out;
  }

  private async resolveDependents(jobs: Job[], deletions: Deletion[], summary: BuildSummary): Promise<Job[]> {
    const out = new Map<string, Job>();
    const addRoute = async (ref: DependentRef) => {
      if (typeof ref === "string") {
        for (const [name, page] of this.aggregateTypes()) {
          if (!page.enumerate && page.route() === ref) {
            out.set(ref, { kind: "aggregate", route: ref, pageType: name, item: null, page: 1, isDependent: true });
            return;
          }
        }
        const row = this.manifest.get(ref);
        if (row && row.sourceRef) {
          const parsed = JSON.parse(row.sourceRef);
          out.set(ref, { kind: "aggregate", route: ref, pageType: row.pageType, item: parsed.item, page: parsed.page, isDependent: true });
        }
        return;
      }
      const page = this.config.pages[ref.type] as AggregatePageConfig | undefined;
      if (!page || !page.enumerate) {
        summary.failed.push({ route: `dependent:${ref.type}`, error: `dependent page type "${ref.type}" is not an enumerated aggregate` });
        return;
      }
      const items = await page.enumerate(this.ctx);
      const item = items.find((i: any) => String(i.slug ?? i.id) === String(ref.id) || String(i.id) === String(ref.id));
      if (!item) return;
      const total = await this.pageCountOf(page, item);
      const depth = Math.min(ref.depth ?? DEFAULT_ARCHIVE_DEPTH, total); // bounded archive rebuild (FR-10)
      for (let p = 1; p <= depth; p++) {
        const route = page.route(item, p);
        out.set(route, { kind: "aggregate", route, pageType: ref.type, item, page: p, isDependent: true });
      }
    };

    for (const job of jobs) {
      if (job.kind !== "article") continue;
      const cfg = this.collectionCfg(job.collectionType);
      for (const ref of cfg.dependents?.(job.article) ?? []) await addRoute(ref);
    }
    for (const del of deletions) {
      if (del.dependentsRef) {
        for (const ref of JSON.parse(del.dependentsRef) as DependentRef[]) await addRoute(ref);
      } else {
        for (const [name, page] of this.aggregateTypes()) {
          if (!page.enumerate) {
            const route = page.route();
            out.set(route, { kind: "aggregate", route, pageType: name, item: null, page: 1, isDependent: true });
          }
        }
      }
    }
    return [...out.values()];
  }

  /** A page's primary file plus its sidecars and data.json (removal order: sidecars first). */
  private pageFilesOf(outputPath: string): string[] {
    const files = [...this.backend.pageSidecars(outputPath)];
    if (this.config.emitData) files.push(dataPathFor(outputPath));
    files.push(outputPath);
    return files;
  }

  private removalJournalPath(): string {
    return join(dirname(this.config.manifest), "pending-removals.json");
  }

  /**
   * Finish file removals from a run that committed its manifest but crashed
   * before deleting the files. The token check discards journals from runs
   * whose transaction rolled back (deleting those files would strand live
   * manifest rows).
   */
  private replayRemovalJournal(): void {
    const path = this.removalJournalPath();
    if (!existsSync(path)) return;
    try {
      const journal = JSON.parse(readFileSync(path, "utf8"));
      if (journal.token && journal.token === this.manifest.getMeta("pendingRemovalsToken")) {
        const writer = new OutputWriter(this.config.outDir);
        for (const p of journal.paths as string[]) writer.deletePage(p);
        this.manifest.setMeta("pendingRemovalsToken", "");
      }
    } catch {
      /* unreadable journal: fall through and discard */
    }
    rmSync(path, { force: true });
  }

  private writeReport(summary: BuildSummary, writer: OutputWriter): string {
    const reportPath = join(dirname(this.config.manifest), "last-build.json");
    mkdirSync(dirname(reportPath), { recursive: true });
    // A file written in several batches (framework extras, padding pages)
    // is listed once; created wins over updated.
    const created = [...new Set(writer.created)];
    const createdSet = new Set(created);
    const updated = [...new Set(writer.updated)].filter((f) => !createdSet.has(f));
    writeFileSync(
      reportPath,
      JSON.stringify(
        { ...summary, files: { created, updated, deleted: writer.deletedFiles } },
        null,
        2
      )
    );
    return reportPath;
  }

  // ---- auxiliary operations ------------------------------------------------

  /**
   * Draft previews. The owned backend renders each draft directly; delegated
   * backends run one framework build for the whole request (see previewDelegated).
   */
  async preview(refs: { slugs?: string[]; ids?: Array<string | number> }): Promise<{
    built: Array<{ route: string; file: string }>;
    failed: PageFailure[];
  }> {
    if (this.backend instanceof DelegatedBackend) return this.previewDelegated(this.backend, refs);
    await this.lock.acquire(this.wait);
    try {
      await this.backend.prepare({ clean: false });
      const writer = new OutputWriter(this.config.outDir);
      const built: Array<{ route: string; file: string }> = [];
      const failed: PageFailure[] = [];
      const targets: Array<{ ref: { slug?: string; id?: string | number }; label: string }> = [
        ...(refs.slugs ?? []).map((s) => ({ ref: { slug: s }, label: `slug:${s}` })),
        ...(refs.ids ?? []).map((id) => ({ ref: { id }, label: `id:${id}` })),
      ];
      for (const { ref, label } of targets) {
        try {
          const { type, value } = parseTargetRef(String(ref.slug ?? ref.id), this.collections().map(([n]) => n));
          const adapter = this.adapterFor(type);
          const fetchOne = adapter.getPreview ?? adapter.getArticle;
          const article = await fetchOne.call(adapter, ref.slug !== undefined ? { slug: value } : { id: value });
          if (!article) {
            failed.push({ route: label, error: "article not found (adapter has no getPreview or the item does not exist)" });
            continue;
          }
          const cfg = this.collectionCfg(type);
          const route = `${this.config.preview.pathPrefix}${cfg.route(article)}`;
          const data = await cfg.data(article);
          const [result] = await this.backend.renderBatch([{ route, pageType: type, data }], { noindex: true });
          if (result.kind !== "html") {
            failed.push({ route, error: result.kind === "failed" ? result.error : "unexpected render result" });
            continue;
          }
          let html = result.html;
          if (this.images) html = (await this.images.localizeHtml(html)).html;
          const outputPath = routeToOutputPath(route);
          writer.writePage(outputPath, html);
          built.push({ route, file: join(this.config.outDir, outputPath) });
        } catch (err: any) {
          failed.push({ route: label, error: err?.message ?? String(err) });
        }
      }
      return { built, failed };
    } finally {
      this.lock.release();
    }
  }

  /**
   * Draft previews on a delegated backend: one framework build renders the
   * drafts at their normal routes in the framework's staging dir, and only
   * those pages are copied out, under the preview prefix. Nothing else from
   * that build is merged and the manifest is not touched, so a draft never
   * replaces a published page. Because the page now lives at a URL the
   * framework's client router does not know, its scripts are removed unless
   * the backend declares them safe to keep: the preview is a static snapshot.
   */
  private async previewDelegated(
    backend: DelegatedBackend,
    refs: { slugs?: string[]; ids?: Array<string | number> }
  ): Promise<{ built: Array<{ route: string; file: string }>; failed: PageFailure[] }> {
    await this.lock.acquire(this.wait);
    try {
      await this.images?.init();
      await backend.prepare({ clean: false });
      const writer = new OutputWriter(this.config.outDir);
      const built: Array<{ route: string; file: string }> = [];
      const failed: PageFailure[] = [];
      const targets: Array<{ ref: { slug?: string; id?: string | number }; label: string }> = [
        ...(refs.slugs ?? []).map((s) => ({ ref: { slug: s }, label: `slug:${s}` })),
        ...(refs.ids ?? []).map((id) => ({ ref: { id }, label: `id:${id}` })),
      ];

      const drafts: RenderJob[] = [];
      for (const { ref, label } of targets) {
        try {
          const { type, value } = parseTargetRef(String(ref.slug ?? ref.id), this.collections().map(([n]) => n));
          const adapter = this.adapterFor(type);
          const fetchOne = adapter.getPreview ?? adapter.getArticle;
          const article = await fetchOne.call(adapter, ref.slug !== undefined ? { slug: value } : { id: value });
          if (!article) {
            failed.push({ route: label, error: "article not found (adapter has no getPreview or the item does not exist)" });
            continue;
          }
          const cfg = this.collectionCfg(type);
          drafts.push({
            route: cfg.route(article),
            pageType: type,
            data: await cfg.data(article),
            article,
            slug: this.slugOf(type, article),
            id: this.idOf(type, article),
          });
        } catch (err: any) {
          failed.push({ route: label, error: err?.message ?? String(err) });
        }
      }
      if (drafts.length === 0) return { built, failed };

      // Keep every dynamic page type present in the framework build.
      const padding: RenderJob[] = [];
      for (const job of await this.paddingJobs(new Set(drafts.map((d) => d.pageType)))) {
        try {
          padding.push((await this.evaluateJob(job)).renderJob);
        } catch {
          /* a padding page that cannot load is left out; the framework build reports its own error if it needs it */
        }
      }

      const draftRoutes = new Set(drafts.map((d) => d.route));
      const results = await backend.renderBatch([...drafts, ...padding.filter((p) => !draftRoutes.has(p.route))]);
      const prefix = this.config.preview.pathPrefix.replace(/^\/+|\/+$/g, "");
      for (const result of results) {
        if (!draftRoutes.has(result.route) || result.kind === "extra") continue;
        const previewRoute = `${this.config.preview.pathPrefix}${result.route}`;
        if (result.kind !== "files") {
          failed.push({ route: previewRoute, error: result.kind === "failed" ? result.error : "unexpected render result" });
          continue;
        }
        try {
          for (const file of result.files) {
            const isHtml = file.relPath.endsWith(".html");
            // Sidecars (RSC payloads, __data.json) only serve client-side
            // navigation, which a script-free snapshot does not do.
            if (!isHtml && !backend.previewKeepsScripts) continue;
            let content = readFileSync(file.absPath, "utf8");
            if (isHtml) {
              content = previewHtml(content, backend.previewKeepsScripts);
              if (this.images) content = (await this.images.localizeHtml(content)).html;
            } else if (this.images) {
              content = this.images.applyKnownMappings(content);
            }
            writer.writePage(`${prefix}/${file.relPath}`, content);
          }
          built.push({ route: previewRoute, file: join(this.config.outDir, prefix, result.outputPath) });
        } catch (err: any) {
          failed.push({ route: previewRoute, error: err?.message ?? String(err) });
        }
      }

      // Stylesheets and other hashed assets the preview pages reference.
      const assets: string[] = [];
      for (const { absPath, relPath } of backend.stagedAssetFiles()) {
        assets.push(relPath);
        const target = join(this.config.outDir, relPath);
        if (existsSync(target)) continue;
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(absPath, target);
      }
      if (assets.length > 0) this.manifest.recordAssetGraph(backend.assetGraphHash, assets);
      return { built, failed };
    } finally {
      this.lock.release();
    }
  }

  /** Garbage-collect hashed asset files no longer referenced by any built page. */
  async gcAssets(dryRun = false): Promise<{ kept: number; deleted: string[]; skipped?: string }> {
    const live = this.manifest.liveAssetGraphHashes();
    const current = this.manifest.getMeta("assetGraphHash");
    if (current) live.add(current);

    const recordedHashes = this.manifest.recordedAssetHashes();
    const missing = [...live].filter((h) => !recordedHashes.has(h));
    if (missing.length > 0) {
      return {
        kept: 0,
        deleted: [],
        skipped: `live asset graph(s) without a recorded file list: ${missing.join(", ")} (built before GC support); rebuild those pages first`,
      };
    }
    const recorded = this.manifest.assetGraphFiles(live);

    const deleted: string[] = [];
    let kept = 0;
    for (const dir of this.backend.assetDirs) {
      const assetsDir = join(this.config.outDir, dir);
      if (!existsSync(assetsDir)) continue;
      const files: string[] = [];
      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, entry.name);
          if (entry.isDirectory()) walk(p);
          else files.push(p);
        }
      };
      walk(assetsDir);
      for (const abs of files) {
        const rel = abs.slice(this.config.outDir.length + 1);
        if (recorded.has(rel)) kept++;
        else {
          if (!dryRun) rmSync(abs);
          deleted.push(rel);
        }
      }
    }
    if (!dryRun) this.manifest.pruneAssetGraphs(live);
    return { kept, deleted };
  }

  async status(): Promise<StatusReport> {
    const counts = this.manifest.counts();
    const current = this.manifest.getMeta("assetGraphHash");
    return {
      totalPages: counts.total,
      byPageType: counts.byPageType,
      codeStale: current ? this.manifest.codeStaleCount(current) : 0,
      lastBuildAt: this.manifest.getMeta("lastBuildAt"),
      lastFullBuildAt: this.manifest.getMeta("lastFullBuildAt"),
      currentAssetGraphHash: current,
    };
  }

  /** Manifest rows whose article no longer exists in the CMS (full ID sweep). */
  private async orphanRows() {
    const orphans = [];
    for (const [type] of this.collections()) {
      const adapter = this.adapterFor(type);
      const liveIds = new Set<string>();
      const guard = pageLoopGuard(adapter.name);
      for (let page = 1; ; page++) {
        const res = await adapter.listArticles({ page, perPage: this.config.cms.perPage });
        guard(res.items, page);
        for (const a of res.items) liveIds.add(this.idOf(type, a));
        if (!res.hasMore || res.items.length === 0) break;
      }
      orphans.push(...this.manifest.all().filter((r) => r.pageType === type && r.articleId && !liveIds.has(r.articleId)));
    }
    return orphans;
  }

  /**
   * Full ID sweep against each collection adapter to find CMS-side deletions
   * (FR-9). With prune, orphans are deleted through the normal build pipeline
   * (files, manifest rows, dependents, sitemap/feed).
   */
  async reconcile(opts: { prune?: boolean } = {}): Promise<{ orphanRoutes: string[] }> {
    if (opts.prune) {
      const summary = await this.build({ reconcile: true });
      return { orphanRoutes: summary.deleted };
    }
    return { orphanRoutes: (await this.orphanRows()).map((r) => r.route) };
  }

  async close(): Promise<void> {
    this.backend.destroy();
    this.manifest.close();
  }
}

// ---- helpers ---------------------------------------------------------------

function describeMode(opts: BuildOptions): string {
  if (opts.adopt) return "adopt";
  if (opts.all) return "all";
  if (opts.limit !== undefined) return `limit ${opts.limit}`;
  if (opts.chunk) return `chunk ${opts.chunk.index}/${opts.chunk.total}`;
  if (opts.stale) return "stale";
  if (opts.chunkSize !== undefined) return `chunk-size ${opts.chunkSize}`;
  if (opts.since !== undefined) return `since ${opts.since}`;
  if (opts.reconcile) return "reconcile";
  if (opts.routes?.length || opts.slugs?.length || opts.ids?.length) return "targeted";
  return "unknown";
}

/**
 * Detect a CMS that ignores the page parameter and returns the same page
 * forever (the serial loops would otherwise never terminate).
 */
function pageLoopGuard(adapterName: string): (items: any[], page: number) => void {
  let prevFirst: string | null = null;
  return (items, page) => {
    if (items.length === 0) return;
    let first: string;
    try {
      first = JSON.stringify(items[0]).slice(0, 500);
    } catch {
      return;
    }
    if (page > 1 && first === prevFirst) {
      throw new Error(
        `CMS adapter "${adapterName}" returned identical consecutive pages (page ${page}); aborting to avoid an infinite pagination loop.`
      );
    }
    prevFirst = first;
  };
}

/** JSON.stringify with sorted object keys, so the content hash is stable across key insertion order. */
function stableStringify(value: any): string {
  return (
    JSON.stringify(value, (_k, v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const sorted: Record<string, any> = {};
        for (const key of Object.keys(v).sort()) sorted[key] = v[key];
        return sorted;
      }
      return v;
    }) ?? "null"
  );
}

/** Parse "collection:value" targeting; bare values default to the "article" collection. */
function parseTargetRef(raw: string, collectionNames: string[]): { type: string; value: string } {
  const idx = raw.indexOf(":");
  if (idx > 0) {
    const type = raw.slice(0, idx);
    if (collectionNames.includes(type)) return { type, value: raw.slice(idx + 1) };
  }
  return { type: collectionNames.includes(DEFAULT_COLLECTION) ? DEFAULT_COLLECTION : collectionNames[0], value: raw };
}

/** data.json sibling for a page's output path (emitData). */
function dataPathFor(outputPath: string): string {
  return outputPath.endsWith("index.html")
    ? outputPath.slice(0, -"index.html".length) + "data.json"
    : outputPath.replace(/\.html$/, ".json");
}

/** Default feed entry mapper for WordPress-shaped articles. */
function defaultFeedItem(a: any): { title: string; description?: string; date?: string } {
  return {
    title: a.title?.rendered ?? a.title ?? String(a.slug ?? a.id ?? "untitled"),
    description: a.excerpt?.rendered ?? undefined,
    date: a.date ?? a.modified ?? a.modifiedAt ?? a.updatedAt ?? undefined,
  };
}

// Index-based, not shift()-based: Array.shift is O(N), which turns large
// batches into O(N^2) and showed up hard in the 200k benchmark.
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Turn a framework-built page into a preview snapshot: mark it noindex and,
 * unless the backend keeps scripts, drop executable scripts and script
 * preloads (structured-data scripts stay).
 */
function previewHtml(html: string, keepScripts: boolean): string {
  if (!keepScripts) {
    html = html
      .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (tag, attrs: string) =>
        /type\s*=\s*["']?application\/ld\+json/i.test(attrs) ? tag : ""
      )
      .replace(/<link\b[^>]*\brel\s*=\s*["']?modulepreload[^>]*>/gi, "")
      .replace(/<link\b(?=[^>]*\brel\s*=\s*["']?preload)(?=[^>]*\bas\s*=\s*["']?script)[^>]*>/gi, "");
  }
  const robots = '<meta name="robots" content="noindex, nofollow">';
  return /<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, (m) => `${m}${robots}`) : `${robots}${html}`;
}
