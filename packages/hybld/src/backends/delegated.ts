import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { RenderBackend, RenderJob, RenderedPage, RendererFactory, ResolvedConfig } from "../types.js";

/**
 * Delegated rendering (strategy B, "scoped build and merge"): hybld writes
 * the batch scope to an NDJSON file, runs the framework's own production
 * build (whose dynamic routes read the scope via a helper), then maps the
 * emitted files back to routes. Static framework routes that were emitted but
 * not requested come back as "extra" pages, which the engine merges too.
 *
 * The asset graph hash is a SOURCE fingerprint, never an output hash: build
 * output (e.g. Next's buildId files) changes on every run, and hashing it
 * would mark the whole catalog code-stale after each incremental build.
 */
export interface DelegatedSpec {
  name: string;
  /** Build command, e.g. ["npx", "astro", "build"]. Runs at the project root. */
  buildCommand: string[];
  /** Where the framework writes its build, relative to root (must differ from hybld's outDir). */
  frameworkOutDir: string;
  /** Source inputs for the fingerprint (dirs or files, relative to root). */
  sourceDirs: string[];
  /** Hashed-asset directories, relative to both the framework outDir and hybld's outDir. */
  assetDirs: string[];
  /** Map a route to its emitted primary file candidates, relative to frameworkOutDir. */
  pageFileCandidates(route: string): string[];
  /** Sidecar files emitted next to a page (e.g. Next's RSC .txt payloads), given the primary file. */
  sidecarsFor?(primaryRelPath: string): string[];
  /** Extra env for the framework build. */
  env?: Record<string, string>;
  /**
   * Post-merge housekeeping in hybld's cumulative outDir, run once per
   * build after pages/assets merged (e.g. Next's Pages Router data JSON
   * fan-out). `removals` are outDir-relative files deleted with the run's
   * deferred deletions.
   */
  finalizeOutDir?(ctx: { outDir: string; stagingDir: string; deletedPageOutputs: string[] }): {
    created: string[];
    updated: string[];
    removals: string[];
  };
}

export function delegatedRenderer(spec: DelegatedSpec): RendererFactory {
  return {
    name: spec.name,
    mode: "delegated",
    create: (config) => new DelegatedBackend(spec, config),
  };
}

export class DelegatedBackend implements RenderBackend {
  readonly mode = "delegated" as const;
  readonly name: string;
  readonly assetDirs: string[];
  private hash: string | null = null;
  private copiedAssets: string[] = [];
  private staticFiles: string[] = [];
  private ranBuild = false;

  constructor(
    private spec: DelegatedSpec,
    private config: ResolvedConfig
  ) {
    this.name = spec.name;
    this.assetDirs = spec.assetDirs;
  }

  async prepare(_opts: { clean: boolean }): Promise<void> {
    if (this.stagingDir() === this.config.outDir) {
      throw new Error(
        `hybld outDir must differ from the ${this.spec.name} build dir ("${this.spec.frameworkOutDir}"): ` +
          `the framework's output is a staging area that hybld merges into its own cumulative outDir.`
      );
    }
    this.hash = this.fingerprint();
  }

  get assetGraphHash(): string {
    if (!this.hash) throw new Error("Backend not prepared yet");
    return this.hash;
  }

  get assetFiles(): string[] {
    return this.copiedAssets;
  }

  private fingerprint(): string {
    const h = createHash("sha256");
    const addFile = (p: string) => {
      const st = statSync(p);
      h.update(p).update(String(st.size)).update(String(st.mtimeMs));
    };
    const walk = (p: string) => {
      if (!existsSync(p)) return;
      const st = statSync(p);
      if (st.isFile()) return addFile(p);
      for (const entry of readdirSync(p, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(join(p, entry.name));
      }
    };
    for (const dir of this.spec.sourceDirs) walk(join(this.config.root, dir));
    return h.digest("hex").slice(0, 12);
  }

  private stagingDir(): string {
    return join(this.config.root, this.spec.frameworkOutDir);
  }

  async renderBatch(jobs: RenderJob[], _opts: { noindex?: boolean } = {}): Promise<RenderedPage[]> {
    // Nothing to build means nothing changed; skip the (expensive) framework build.
    if (jobs.length === 0) {
      this.copiedAssets = [];
      this.staticFiles = [];
      this.ranBuild = false;
      return [];
    }
    this.ranBuild = true;
    // 1. Scope file: one NDJSON line per job, consumed by the framework helpers.
    const scopePath = join(this.config.root, ".hybld", "scope.ndjson");
    mkdirSync(join(this.config.root, ".hybld"), { recursive: true });
    writeFileSync(
      scopePath,
      jobs
        .map((j) =>
          JSON.stringify({
            route: j.route,
            pageType: j.pageType,
            slug: j.slug ?? undefined,
            id: j.id ?? undefined,
            page: j.page ?? undefined,
            item: j.item ?? undefined,
            data: j.data,
          })
        )
        .join("\n")
    );

    // 2. Framework build (its own outDir, later merged by the engine).
    await this.runBuild(scopePath);

    // 3. Map requested routes to emitted files.
    const staging = this.stagingDir();
    const claimed = new Set<string>();
    const results: RenderedPage[] = [];
    for (const job of jobs) {
      const primary = this.spec
        .pageFileCandidates(job.route)
        .find((rel) => existsSync(join(staging, rel)));
      if (!primary) {
        results.push({
          route: job.route,
          kind: "failed",
          error: `framework build emitted no file for this route (looked for ${this.spec.pageFileCandidates(job.route).join(", ")})`,
        });
        continue;
      }
      const rels = [primary, ...(this.spec.sidecarsFor?.(primary) ?? [])].filter((rel) =>
        existsSync(join(staging, rel))
      );
      rels.forEach((r) => claimed.add(r));
      results.push({
        route: job.route,
        kind: "files",
        outputPath: primary,
        files: rels.map((rel) => ({ absPath: join(staging, rel), relPath: rel })),
      });
    }

    // 4. Extras: pages the framework always rebuilds (static routes like home/404).
    for (const rel of this.emittedHtml(staging)) {
      if (claimed.has(rel)) continue;
      const sidecars = (this.spec.sidecarsFor?.(rel) ?? []).filter((s) => existsSync(join(staging, s)));
      [rel, ...sidecars].forEach((r) => claimed.add(r));
      results.push({
        route: relToRoute(rel),
        kind: "extra",
        outputPath: rel,
        files: [rel, ...sidecars].map((r) => ({ absPath: join(staging, r), relPath: r })),
      });
    }

    // 5. Report the framework's hashed assets for the engine to merge append-only.
    this.copiedAssets = [];
    for (const dir of this.spec.assetDirs) {
      const abs = join(staging, dir);
      if (!existsSync(abs)) continue;
      walkFiles(abs, (file) => this.copiedAssets.push(relative(staging, file)));
    }

    // 6. Everything else the framework emitted (public/ files, robots.txt,
    // favicons, rss.xml, ...): not pages, not hashed assets, but they must
    // reach the deployed site. The engine copies these overwrite-style.
    this.staticFiles = [];
    walkFiles(staging, (file) => {
      const rel = relative(staging, file);
      if (claimed.has(rel)) return;
      if (rel.endsWith(".html")) return; // extras already handled every HTML file
      if (this.spec.assetDirs.some((d) => rel.startsWith(d))) return;
      this.staticFiles.push(rel);
    });

    return results;
  }

  /** All emitted HTML files, relative to the framework outDir, excluding asset dirs. */
  private emittedHtml(staging: string): string[] {
    const out: string[] = [];
    if (!existsSync(staging)) return out;
    walkFiles(staging, (file) => {
      const rel = relative(staging, file);
      if (!rel.endsWith(".html")) return;
      if (this.spec.assetDirs.some((d) => rel.startsWith(d))) return;
      out.push(rel);
    });
    return out;
  }

  /** Absolute staging paths for asset files (relPath preserved for the merge). */
  stagedAssetFiles(): Array<{ absPath: string; relPath: string }> {
    return this.copiedAssets.map((rel) => ({ absPath: join(this.stagingDir(), rel), relPath: rel }));
  }

  /** Non-page, non-asset framework outputs (public/ files, robots.txt, ...). */
  stagedStaticFiles(): Array<{ absPath: string; relPath: string }> {
    return this.staticFiles.map((rel) => ({ absPath: join(this.stagingDir(), rel), relPath: rel }));
  }

  private runBuild(scopePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = this.spec.buildCommand;
      const child = spawn(cmd, args, {
        cwd: this.config.root,
        env: {
          ...process.env,
          ...this.spec.env,
          HYBLD_SCOPE: scopePath,
          HYBLD_INTERNAL: "1",
          // The helpers' scope-miss fallback loads the hybld config inside
          // the framework build; forward a non-default config path so
          // --config projects don't fall back to (or miss) the default name.
          ...(this.config.configFile ? { HYBLD_CONFIG: this.config.configFile } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Keep only the tail: a large export prints per-page progress lines and
      // an unbounded buffer would hold the whole log in memory.
      let output = "";
      const append = (d: any) => {
        output = (output + d).slice(-65_536);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${this.spec.buildCommand.join(" ")} failed (exit ${code}):\n${output.slice(-2000)}`));
      });
    });
  }

  pageSidecars(outputPath: string): string[] {
    return this.spec.sidecarsFor?.(outputPath) ?? [];
  }

  finalizeMerge(ctx: { deletedPageOutputs: string[] }): { created: string[]; updated: string[]; removals: string[] } {
    // Deletion housekeeping must run even without a framework build (a
    // deletions-only run); fan-out/prune only makes sense after one.
    if (!this.spec.finalizeOutDir) return { created: [], updated: [], removals: [] };
    if (!this.ranBuild && ctx.deletedPageOutputs.length === 0) return { created: [], updated: [], removals: [] };
    return this.spec.finalizeOutDir({
      outDir: this.config.outDir,
      stagingDir: this.ranBuild ? this.stagingDir() : "",
      deletedPageOutputs: ctx.deletedPageOutputs,
    });
  }

  destroy(): void {}
}

function walkFiles(dir: string, visit: (absFile: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, visit);
    else visit(p);
  }
}

function relToRoute(rel: string): string {
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"index.html".length)}`;
  return `/${rel}`;
}
