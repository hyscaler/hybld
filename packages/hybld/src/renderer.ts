import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ResolvedConfig } from "./types.js";

export interface RenderInput {
  route: string;
  pageType: string;
  data: any;
  /** Language versions of the page (collections that define `alternates`), for hreflang head tags. */
  alternates?: Array<{ lang: string; route: string }>;
}

export interface RenderResult {
  html: string;
  head?: string;
}

type RenderFn = (input: RenderInput) => RenderResult | Promise<RenderResult | string> | string;

/**
 * Built-in prerenderer (FR-6): runs the Vite client + SSR builds, renders
 * routes through the user's entry-server module (in a worker pool when
 * render.workers > 1), and reuses previous build artifacts when the source
 * fingerprint is unchanged so repeat CLI builds skip Vite entirely.
 */
export class Renderer {
  private template: string | null = null;
  private renderFn: RenderFn | null = null;
  private pool: RenderPool | null = null;
  private hash: string | null = null;
  private fingerprint: string | null = null;
  private assetFiles: string[] = [];

  constructor(
    private cfg: ResolvedConfig,
    /** When true (Vite plugin mode) the client build already ran; only the SSR build is performed. */
    private externalClientBuild = false
  ) {}

  get assetGraphHash(): string {
    if (!this.hash) throw new Error("Renderer not built yet");
    return this.hash;
  }

  /** Asset files (relative to outDir) belonging to the current asset graph. */
  get currentAssetFiles(): string[] {
    return this.assetFiles;
  }

  private cacheDir() {
    return join(dirname(this.cfg.manifest), "build-cache");
  }
  private templatePath() {
    return join(this.cacheDir(), "template.html");
  }
  private metaPath() {
    return join(this.cacheDir(), "build-meta.json");
  }
  private ssrDir() {
    return join(this.cacheDir(), "ssr");
  }

  async ensureBuilt(clean = false): Promise<void> {
    const fp = this.computeFingerprint();
    if (!clean && this.fingerprint === fp && this.template) return;

    if (!clean && !this.externalClientBuild && this.tryReuse(fp)) {
      this.fingerprint = fp;
      return;
    }

    await this.runViteBuilds(clean);
    writeFileSync(
      this.metaPath(),
      JSON.stringify({ fingerprint: fp, bundleFile: this.bundleFile(), assetFiles: this.assetFiles })
    );
    this.fingerprint = fp;
  }

  /** Hash of source inputs; when unchanged, cached template + SSR bundle are reused. */
  private computeFingerprint(): string {
    const h = createHash("sha256");
    const addFile = (p: string) => {
      if (!existsSync(p)) return;
      const st = statSync(p);
      h.update(p).update(String(st.size)).update(String(st.mtimeMs));
    };
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else addFile(p);
      }
    };
    walk(join(this.cfg.root, "src"));
    walk(join(this.cfg.root, "public"));
    addFile(this.cfg.render.template);
    addFile(join(this.cfg.root, "package.json"));
    for (const name of [
      "vite.config.ts",
      "vite.config.js",
      "vite.config.mts",
      "vite.config.mjs",
      // Env files feed import.meta.env at build time; lockfiles catch
      // dependency upgrades that never touch package.json.
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "bun.lockb",
      "postcss.config.js",
      "postcss.config.cjs",
      "postcss.config.mjs",
      "tailwind.config.js",
      "tailwind.config.cjs",
      "tailwind.config.mjs",
      "tailwind.config.ts",
      "hybld.config.ts",
      "hybld.config.mts",
      "hybld.config.js",
      "hybld.config.mjs",
    ]) {
      addFile(join(this.cfg.root, name));
    }
    // Config values baked into the build artifacts.
    h.update(JSON.stringify([this.cfg.basePath, this.cfg.render.entry, this.cfg.render.template]));
    return h.digest("hex").slice(0, 16);
  }

  private bundleFile(): string | null {
    if (!existsSync(this.ssrDir())) return null;
    const files = readdirSync(this.ssrDir()).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
    // Prefer the file named after the SSR entry; a dynamic import can make
    // Rollup emit sibling chunks that must not be mistaken for the entry.
    const entryBase = basename(this.cfg.render.entry).replace(/\.(tsx|ts|jsx|js|mjs)$/, "");
    return files.find((f) => f === `${entryBase}.js` || f === `${entryBase}.mjs`) ?? files[0] ?? null;
  }

  private tryReuse(fp: string): boolean {
    try {
      if (!existsSync(this.metaPath()) || !existsSync(this.templatePath())) return false;
      const meta = JSON.parse(readFileSync(this.metaPath(), "utf8"));
      if (meta.fingerprint !== fp || !meta.bundleFile) return false;
      const bundlePath = join(this.ssrDir(), meta.bundleFile);
      if (!existsSync(bundlePath)) return false;
      // The cached template references hashed client assets; if they are gone
      // from outDir (e.g. rm -rf dist), skipping the client build would ship
      // pages whose scripts and styles 404.
      const assetFiles: string[] = meta.assetFiles ?? [];
      if (assetFiles.length === 0) return false;
      for (const f of assetFiles) {
        if (!existsSync(join(this.cfg.outDir, f))) return false;
      }
      this.assetFiles = assetFiles;
      this.adoptArtifacts(readFileSync(this.templatePath(), "utf8"), bundlePath);
      return true;
    } catch {
      return false;
    }
  }

  private async runViteBuilds(clean: boolean): Promise<void> {
    const { build } = await import("vite");
    // Guard against recursion when the hybld Vite plugin is in the user's
    // vite.config: internal builds must not re-trigger the plugin. Cleared
    // afterwards so long-lived processes (vite build --watch) are not
    // permanently guarded.
    const prevInternal = process.env.HYBLD_INTERNAL;
    process.env.HYBLD_INTERNAL = "1";
    try {
      await this.runViteBuildsInner(build, clean);
    } finally {
      if (prevInternal === undefined) delete process.env.HYBLD_INTERNAL;
      else process.env.HYBLD_INTERNAL = prevInternal;
    }
  }

  private async runViteBuildsInner(build: typeof import("vite").build, clean: boolean): Promise<void> {
    const common = {
      root: this.cfg.root,
      base: this.cfg.basePath,
      logLevel: "warn" as const,
      configFile: findViteConfig(this.cfg.root),
    };

    if (!this.externalClientBuild) {
      // Client build: append-only into outDir (FR-6) unless --clean.
      await build({ ...common, build: { outDir: this.cfg.outDir, emptyOutDir: clean, manifest: true } });
    }

    // The generated index.html is our per-page template; move it out of the
    // output dir so the "/" route's prerendered page can own that path.
    const generated = join(this.cfg.outDir, "index.html");
    if (!existsSync(generated)) {
      throw new Error(`Vite client build produced no ${generated}; is ${this.cfg.render.template} present?`);
    }
    mkdirSync(this.cacheDir(), { recursive: true });
    const templateContent = readFileSync(generated, "utf8");
    writeFileSync(this.templatePath(), templateContent);
    renameSync(generated, join(this.cacheDir(), "template.last.html"));

    // Asset graph file list from Vite's build manifest (used by `assets gc`).
    this.assetFiles = readAssetFiles(join(this.cfg.outDir, ".vite", "manifest.json"));

    // SSR build of the user's entry-server.
    await build({ ...common, build: { ssr: this.cfg.render.entry, outDir: this.ssrDir(), emptyOutDir: true } });
    const bundle = this.bundleFile();
    if (!bundle) throw new Error(`SSR build produced no JS bundle in ${this.ssrDir()}`);
    this.adoptArtifacts(templateContent, join(this.ssrDir(), bundle));
  }

  private adoptArtifacts(templateContent: string, bundlePath: string): void {
    for (const ph of ["<!--app-html-->", "<!--app-head-->"]) {
      if (!templateContent.includes(ph)) {
        throw new Error(`index.html is missing the ${ph} placeholder required by hybld.`);
      }
    }
    if (!templateContent.includes("</body>")) {
      throw new Error("index.html is missing </body>, which hybld needs to inject the hydration payload.");
    }
    this.template = templateContent;
    this.destroyPool();
    this.renderFn = null;
    this.hash = createHash("sha256")
      .update(templateContent)
      .update(readFileSync(bundlePath))
      .digest("hex")
      .slice(0, 12);

    if (this.cfg.render.workers > 1) {
      this.pool = new RenderPool(bundlePath, this.cfg.render.workers, this.cfg.render.timeout);
    } else {
      this.renderFn = null;
      this.inlineBundlePath = bundlePath;
    }
  }

  private inlineBundlePath: string | null = null;

  private async loadInline(): Promise<RenderFn> {
    if (this.renderFn) return this.renderFn;
    if (!this.inlineBundlePath) throw new Error("Renderer not built yet");
    const mod: any = await import(`${pathToFileURL(this.inlineBundlePath).href}?t=${Date.now()}`);
    if (typeof mod.default !== "function") {
      throw new Error(
        `${this.cfg.render.entry} must default-export a render function ({ route, pageType, data }) => ({ html, head })`
      );
    }
    this.renderFn = mod.default;
    return this.renderFn!;
  }

  async renderPage(input: RenderInput, renderOpts: { noindex?: boolean } = {}): Promise<string> {
    if (!this.template) throw new Error("Renderer not built yet");
    let result: RenderResult;
    if (this.pool) {
      result = await this.pool.exec(input);
    } else {
      const fn = await this.loadInline();
      const r = await withTimeout(
        Promise.resolve(fn(input)),
        this.cfg.render.timeout,
        `render of ${input.route} timed out after ${this.cfg.render.timeout}ms`
      );
      result = typeof r === "string" ? { html: r, head: "" } : r;
    }
    const payload = JSON.stringify({ route: input.route, pageType: input.pageType, data: input.data }).replace(
      /</g,
      "\\u003c"
    );
    let head = result.head ?? "";
    if (renderOpts.noindex) head = `<meta name="robots" content="noindex, nofollow">\n    ${head}`;
    // spliceOnce, not String.replace: replacement text is CMS-controlled and
    // must not be interpreted for $-substitution patterns ($&, $', $`).
    let out = this.template;
    out = spliceOnce(out, "<!--app-head-->", head);
    out = spliceOnce(out, "<!--app-html-->", result.html);
    // Anchor on the template's final </body> so rendered content containing a
    // literal </body> cannot capture the hydration payload mid-page.
    const anchor = out.lastIndexOf("</body>");
    out =
      out.slice(0, anchor) + `<script>window.__HYBLD_DATA__=${payload}</script>` + out.slice(anchor);
    return out;
  }

  private destroyPool(): void {
    this.pool?.destroy();
    this.pool = null;
  }

  destroy(): void {
    this.destroyPool();
  }
}

interface PoolTask {
  input: RenderInput;
  resolve: (r: RenderResult) => void;
  reject: (e: Error) => void;
}

interface PoolSlot {
  worker: Worker;
  /** Job currently dispatched to this worker (with its id and timeout timer). */
  current: { id: number; task: PoolTask; timer: NodeJS.Timeout } | null;
  lastError: Error | null;
  /** Set when we terminate this worker for a render timeout (a forward-progress exit). */
  timedOut: boolean;
}

/**
 * Fixed-size worker pool over render-worker.js. Crashed workers are removed
 * from the pool (postMessage to a dead worker is a silent no-op that would
 * otherwise deadlock the batch) and respawned within a bounded budget; jobs
 * are individually timed out so a hung render fails instead of stalling.
 */
class RenderPool {
  private workers: PoolSlot[] = [];
  private queue: PoolTask[] = [];
  private nextId = 1;
  private destroyed = false;
  private respawnsLeft: number;
  private readonly bust = Date.now();

  constructor(
    private bundlePath: string,
    size: number,
    private timeoutMs: number
  ) {
    // One free restart per slot; a bundle that kills every worker at startup
    // exhausts this quickly and fails the queue instead of looping forever.
    this.respawnsLeft = size;
    for (let i = 0; i < size; i++) this.spawn();
  }

  private spawn(): void {
    const worker = new Worker(new URL("./render-worker.js", import.meta.url), {
      workerData: { bundlePath: this.bundlePath, bust: this.bust },
    });
    const slot: PoolSlot = { worker, current: null, lastError: null, timedOut: false };
    worker.on("message", (msg: any) => {
      if (msg.ready) return;
      const current = slot.current;
      if (!current || current.id !== msg.id) return;
      clearTimeout(current.timer);
      slot.current = null;
      if (msg.error !== undefined) current.task.reject(new Error(String(msg.error) || "render failed"));
      else current.task.resolve({ html: msg.html, head: msg.head });
      this.drain();
    });
    worker.on("error", (err) => {
      slot.lastError = err instanceof Error ? err : new Error(String(err));
    });
    worker.on("exit", () => {
      if (this.destroyed) return;
      this.workers = this.workers.filter((s) => s !== slot);
      const current = slot.current;
      // Forward progress = this worker had already failed a page before exiting
      // (crash mid-render, or our own timeout-kill). Respawning after such an
      // exit cannot loop forever, because the queue shrank by that page; the
      // finite budget is reserved for IDLE exits (a bundle that fails at module
      // load and never takes a task), which is the only real infinite-loop risk.
      const madeProgress = Boolean(current) || slot.timedOut;
      if (current) {
        clearTimeout(current.timer);
        slot.current = null;
        current.task.reject(
          slot.lastError ?? new Error(`render worker exited unexpectedly while rendering ${current.task.input.route}`)
        );
      }
      if (madeProgress) {
        this.spawn();
        this.drain();
      } else if (this.respawnsLeft > 0) {
        this.respawnsLeft--;
        this.spawn();
        this.drain();
      } else if (this.workers.length === 0) {
        const err = slot.lastError ?? new Error("all render workers exited; SSR bundle may be failing at load time");
        for (const task of this.queue.splice(0)) task.reject(err);
      }
    });
    // Deliberately not unref'd: an unref'd worker lets the event loop drain
    // while the main thread awaits render results, silently killing the
    // process mid-build. Builder.close() terminates the pool for clean exit.
    this.workers.push(slot);
  }

  exec(input: RenderInput): Promise<RenderResult> {
    return new Promise((resolve, reject) => {
      this.queue.push({ input, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const slot = this.workers.find((w) => !w.current);
      if (!slot) return;
      const task = this.queue.shift()!;
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (slot.current?.id !== id) return;
        slot.current = null;
        slot.timedOut = true; // mark as forward-progress so the respawn is free
        task.reject(new Error(`render of ${task.input.route} timed out after ${this.timeoutMs}ms`));
        // The worker may be stuck in user code; replace it (exit handler respawns).
        void slot.worker.terminate();
      }, this.timeoutMs);
      timer.unref?.();
      slot.current = { id, task, timer };
      slot.worker.postMessage({ id, input: task.input });
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const { worker, current } of this.workers) {
      if (current) clearTimeout(current.timer);
      void worker.terminate();
    }
    this.workers = [];
  }
}

function spliceOnce(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle);
  if (at === -1) return haystack;
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

function readAssetFiles(viteManifestPath: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(viteManifestPath, "utf8"));
    const files = new Set<string>();
    for (const entry of Object.values(manifest) as any[]) {
      if (entry.file) files.add(entry.file);
      for (const c of entry.css ?? []) files.add(c);
      for (const a of entry.assets ?? []) files.add(a);
    }
    return [...files];
  } catch {
    return [];
  }
}

function findViteConfig(root: string): string | undefined {
  for (const name of ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"]) {
    const p = join(root, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}
