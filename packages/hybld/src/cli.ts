import { createBuilder } from "./builder.js";
import { Manifest } from "./manifest.js";
import { Redirects } from "./redirects.js";
import { startServer } from "./serve.js";
import { pullManifest, pushManifest, syncOutput } from "./sync.js";
import { dirname, join, resolve } from "node:path";
import type { BuildOptions, BuildSummary } from "./types.js";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const valueFlags = new Set([
    "limit", "chunk", "chunk-size", "routes", "slugs", "ids", "since", "config", "concurrency", "o",
    "port", "host", "secret", "redirects", "url",
  ]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length === 2)) {
      const name = arg.replace(/^-+/, "");
      const eq = name.indexOf("=");
      if (eq !== -1) {
        flags[name.slice(0, eq)] = name.slice(eq + 1);
      } else if (valueFlags.has(name) && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) {
        flags[name] = rest[++i];
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

/** Parse a numeric flag value; NaN must fail loudly, not silently change the build scope. */
function numericFlag(name: string, value: string | boolean, opts: { min?: number } = {}): number {
  const n = Number(value);
  if (typeof value === "boolean" || !Number.isFinite(n)) {
    throw new Error(`--${name} expects a number, got: ${value}`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`--${name} must be >= ${opts.min}, got: ${n}`);
  }
  return n;
}

function toBuildOptions(flags: Record<string, string | boolean>): BuildOptions {
  const opts: BuildOptions = {};
  if (flags.all) opts.all = true;
  if (flags.limit !== undefined) opts.limit = numericFlag("limit", flags.limit, { min: 1 });
  if (typeof flags.chunk === "string") {
    const m = flags.chunk.match(/^(\d+)\/(\d+)$/);
    if (!m) throw new Error(`--chunk expects i/n (e.g. 3/10), got: ${flags.chunk}`);
    opts.chunk = { index: Number(m[1]), total: Number(m[2]) };
    if (opts.chunk.total < 1) throw new Error(`--chunk total must be >= 1, got: ${flags.chunk}`);
    if (opts.chunk.index < 1 || opts.chunk.index > opts.chunk.total) {
      throw new Error(`--chunk index must be between 1 and ${opts.chunk.total}, got: ${flags.chunk}`);
    }
  }
  if (flags["chunk-size"] !== undefined) opts.chunkSize = numericFlag("chunk-size", flags["chunk-size"], { min: 1 });
  if (typeof flags.routes === "string") opts.routes = flags.routes.split(",").filter(Boolean);
  if (typeof flags.slugs === "string") opts.slugs = flags.slugs.split(",").filter(Boolean);
  if (typeof flags.ids === "string") opts.ids = flags.ids.split(",").filter(Boolean);
  if (typeof flags.since === "string") opts.since = flags.since;
  if (flags.stale) opts.stale = true;
  if (flags.clean) opts.clean = true;
  if (flags["dry-run"]) opts.dryRun = true;
  if (flags.force) opts.force = true;
  if (flags["no-dependents"]) opts.noDependents = true;
  if (flags["fail-fast"]) opts.failFast = true;
  if (flags.concurrency !== undefined) opts.concurrency = numericFlag("concurrency", flags.concurrency, { min: 1 });

  const selectors = [
    opts.all, opts.limit !== undefined, opts.chunk, opts.routes?.length || opts.slugs?.length || opts.ids?.length,
    opts.since !== undefined, opts.stale,
    opts.chunkSize !== undefined && !opts.stale ? true : undefined,
  ].filter(Boolean).length;
  if (selectors === 0) throw new Error("build requires a scope: --all, --limit, --chunk, --chunk-size, --routes/--slugs/--ids, --since or --stale");
  if (selectors > 1) throw new Error("build accepts exactly one scope selector (--chunk-size may only combine with --stale)");
  return opts;
}

function printSummary(s: BuildSummary, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  if (s.dryRun) {
    console.log(`[dry-run] mode=${s.mode}`);
    console.log(`  would build ${s.plannedRoutes?.length ?? 0} page(s):`);
    for (const r of s.plannedRoutes ?? []) console.log(`    ${r}`);
    if (s.deleted.length) console.log(`  would delete: ${s.deleted.join(", ")}`);
    return;
  }
  console.log(`hybld build (${s.mode}) finished in ${(s.durationMs / 1000).toFixed(1)}s`);
  console.log(`  built: ${s.built.length}  skipped: ${s.skipped.length}  failed: ${s.failed.length}  deleted: ${s.deleted.length}  moved: ${s.moved.length}`);
  if (s.dependentsRebuilt.length) console.log(`  dependents rebuilt: ${s.dependentsRebuilt.join(", ")}`);
  if (s.moved.length) for (const m of s.moved) console.log(`  moved: ${m.from} -> ${m.to}`);
  if (s.failed.length) for (const f of s.failed) console.log(`  FAILED ${f.route}: ${f.error}`);
  console.log(`  cms requests: ${s.cmsRequests}  asset graph: ${s.assetGraphHash}`);
  if (s.reportPath) console.log(`  report: ${s.reportPath}`);
}

async function main(): Promise<number> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
  const json = Boolean(flags.json);
  const configFile = typeof flags.config === "string" ? flags.config : undefined;

  if (command === "build") {
    const opts = toBuildOptions(flags);
    const builder = await createBuilder({
      configFile,
      wait: Boolean(flags.wait),
      log: flags.verbose ? (m) => console.error(`[hybld] ${m}`) : undefined,
    });
    try {
      const summary = await builder.build(opts);
      printSummary(summary, json);
      return summary.failed.length > 0 ? 2 : 0;
    } finally {
      await builder.close();
    }
  }

  if (command === "status") {
    const builder = await createBuilder({ configFile });
    try {
      const report = await builder.status();
      const extra: any = {};
      if (flags.reconcile) {
        const prune = Boolean(flags.prune);
        const { orphanRoutes } = await builder.reconcile({ prune });
        extra.orphanRoutes = orphanRoutes;
        extra.pruned = prune;
      }
      if (json) {
        console.log(JSON.stringify({ ...report, ...extra }, null, 2));
      } else {
        console.log(`pages: ${report.totalPages}  code-stale: ${report.codeStale}`);
        console.log(`by type: ${JSON.stringify(report.byPageType)}`);
        console.log(`last build: ${report.lastBuildAt ?? "never"}  last full build: ${report.lastFullBuildAt ?? "never"}`);
        if (extra.orphanRoutes) {
          console.log(
            extra.pruned
              ? `orphans pruned (files + manifest + dependents): ${extra.orphanRoutes.length}`
              : `orphans (deleted in CMS, still built): ${extra.orphanRoutes.length} (add --prune to delete them)`
          );
          for (const r of extra.orphanRoutes) console.log(`  ${r}`);
        }
      }
      return 0;
    } finally {
      await builder.close();
    }
  }

  if (command === "manifest") {
    const [sub, ...files] = positionals;
    const builder = await createBuilder({ configFile });
    const manifestPath = builder.config.manifest;
    await builder.close();

    if (sub === "push" || sub === "pull") {
      const url = typeof flags.url === "string" ? flags.url : undefined;
      if (!url) {
        console.error(`usage: hybld manifest ${sub} --url <http-url>`);
        return 1;
      }
      if (sub === "push") await pushManifest(manifestPath, url);
      else await pullManifest(manifestPath, url);
      console.log(`manifest ${sub === "push" ? "pushed to" : "pulled from"} ${url}`);
      return 0;
    }

    const manifest = new Manifest(manifestPath);
    try {
      if (sub === "export" && files[0]) {
        const n = manifest.exportJson(files[0]);
        console.log(`exported ${n} page(s) to ${files[0]}`);
        return 0;
      }
      if (sub === "import" && files[0]) {
        const n = manifest.importJson(files[0]);
        console.log(`imported ${n} page(s) from ${files[0]}`);
        return 0;
      }
      if (sub === "merge" && files[0]) {
        const n = manifest.merge(files[0]);
        console.log(`merged ${n} newer page(s) from ${files[0]} into ${manifestPath}`);
        return 0;
      }
      console.error("usage: hybld manifest export <file> | import <file> | merge <other.db> | push --url <u> | pull --url <u>");
      return 1;
    } finally {
      manifest.close();
    }
  }

  if (command === "preview") {
    const slugs = typeof flags.slugs === "string" ? flags.slugs.split(",").filter(Boolean) : undefined;
    const ids = typeof flags.ids === "string" ? flags.ids.split(",").filter(Boolean) : undefined;
    if (!slugs?.length && !ids?.length) {
      console.error("usage: hybld preview --slugs <s1,s2> | --ids <id1,id2>");
      return 1;
    }
    const builder = await createBuilder({ configFile, wait: Boolean(flags.wait) });
    try {
      const result = await builder.preview({ slugs, ids });
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        for (const b of result.built) console.log(`preview built: ${b.route} -> ${b.file}`);
        for (const f of result.failed) console.log(`FAILED ${f.route}: ${f.error}`);
      }
      return result.failed.length > 0 ? 2 : 0;
    } finally {
      await builder.close();
    }
  }

  if (command === "assets" && positionals[0] === "gc") {
    const builder = await createBuilder({ configFile });
    try {
      const result = await builder.gcAssets(Boolean(flags["dry-run"]));
      if (json) console.log(JSON.stringify(result, null, 2));
      else if (result.skipped) console.log(`gc skipped: ${result.skipped}`);
      else {
        console.log(`${flags["dry-run"] ? "[dry-run] would delete" : "deleted"} ${result.deleted.length} asset file(s), keeping ${result.kept}`);
        for (const f of result.deleted) console.log(`  ${f}`);
      }
      return 0;
    } finally {
      await builder.close();
    }
  }

  if (command === "sync") {
    const targetDir = positionals[0];
    if (!targetDir) {
      console.error("usage: hybld sync <targetDir> [--delete] [--redirects netlify|nginx]");
      return 1;
    }
    const builder = await createBuilder({ configFile });
    const cfg = builder.config;
    await builder.close();
    const format = flags.redirects === "netlify" || flags.redirects === "nginx" ? flags.redirects : undefined;
    const result = syncOutput({
      outDir: cfg.outDir,
      reportPath: join(dirname(cfg.manifest), "last-build.json"),
      targetDir: resolve(targetDir),
      deleteRemoved: Boolean(flags.delete),
      redirects: format ? { format, map: new Redirects(cfg.redirects.file).entries } : undefined,
    });
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`synced ${result.copied.length} file(s), deleted ${result.deleted.length}`);
      if (result.redirectsFile) console.log(`redirects written: ${result.redirectsFile}`);
    }
    return 0;
  }

  if (command === "serve") {
    const builder = await createBuilder({
      configFile,
      wait: true,
      log: (m) => console.error(`[hybld] ${m}`),
    });
    const server = startServer(builder, {
      port: flags.port !== undefined ? numericFlag("port", flags.port, { min: 1 }) : 4600,
      host: typeof flags.host === "string" ? flags.host : undefined,
      secret: typeof flags.secret === "string" ? flags.secret : undefined,
      insecure: Boolean(flags.insecure),
      serveStatic: Boolean(flags.static),
      regenOnMiss: Boolean(flags.regen),
      log: (m) => console.error(`[hybld] ${m}`),
    });
    await new Promise<void>((resolveExit) => {
      const stop = () => server.close(() => builder.close().then(resolveExit));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  }

  console.log(`hybld: incremental static builds for React + Vite, Next.js, and Astro

usage:
  hybld build --all [--clean]
  hybld build --limit <n>
  hybld build --chunk <i>/<n>
  hybld build --chunk-size <n>
  hybld build --routes <r1,r2> | --slugs <s1,s2> | --ids <id1,id2>
                (--slugs/--ids accept collection prefixes: --ids author:5)
  hybld build --since last-build | --since <ISO date>
  hybld build --stale [--chunk-size <n>]
  hybld preview --slugs <s1,s2> | --ids <id1,id2>
  hybld serve [--port 4600] [--host 127.0.0.1] [--secret <s>] [--static] [--regen]
  hybld sync <targetDir> [--delete] [--redirects netlify|nginx]
  hybld assets gc [--dry-run]
  hybld status [--reconcile [--prune]]
  hybld manifest export|import <file> | merge <other.db> | push|pull --url <u>

shared flags: --config <path> --concurrency <n> --dry-run --force
              --no-dependents --fail-fast --wait --json --verbose`);
  return command === "help" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`hybld: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
