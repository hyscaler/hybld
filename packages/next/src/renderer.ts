import { existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { delegatedRenderer, type RendererFactory } from "hybld";

export interface NextRendererOptions {
  /** Next's export dir (relative to root). Default "out". */
  nextOutDir?: string;
  /** Build command. Default ["npx", "next", "build"]. */
  buildCommand?: string[];
  /** Source dirs for the fingerprint. Default app, pages, src, components, lib, styles, public, next.config.*. */
  sourceDirs?: string[];
  /**
   * How many _next/data/<buildId> dirs to retain (Pages Router client
   * navigation JSON). Every build mints a new buildId; fresh JSON is fanned
   * out to all retained dirs so visitors on older HTML keep seeing current
   * content. Older dirs are pruned (their visitors fall back to full-page
   * navigation). Default 3.
   */
  keepBuildIds?: number;
}

/**
 * Next.js render backend (delegated strategy) for `output: "export"` sites.
 * Requires `trailingSlash: true` in next.config so emitted paths are
 * route/index.html. Dynamic routes opt in via hybldParams() in their
 * generateStaticParams; static routes rebuild every run and merge as extras.
 *
 * Note: sites served by a Next server should prefer Next's native ISR;
 * this backend exists for the static-hosting case, where Next itself has no
 * incremental story. Import this only in hybld.config.ts.
 */
export function nextRenderer(opts: NextRendererOptions = {}): RendererFactory {
  const keepBuildIds = Math.max(1, opts.keepBuildIds ?? 3);
  return delegatedRenderer({
    name: "next",
    buildCommand: opts.buildCommand ?? ["npx", "next", "build"],
    frameworkOutDir: opts.nextOutDir ?? "out",
    sourceDirs: opts.sourceDirs ?? [
      "app",
      "pages",
      "src",
      "components",
      "lib",
      "styles",
      "public",
      "next.config.mjs",
      "next.config.ts",
      "next.config.js",
      "package.json",
    ],
    // _next/static: hashed chunks (both routers). _next/data: the Pages
    // Router's per-page JSON for client-side navigation; merged append-only,
    // then finalizeOutDir fans fresh JSON across retained buildId dirs.
    assetDirs: ["_next/static", "_next/data"],
    env: { NEXT_TELEMETRY_DISABLED: "1" },
    pageFileCandidates: (route) => {
      if (route === "/") return ["index.html"];
      const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
      return [`${trimmed}/index.html`, `${trimmed}.html`];
    },
    // App Router static export writes an RSC payload (.txt) next to each page;
    // it must travel with the HTML so client-side navigation stays consistent.
    // With trailingSlash: true the layout is route/index.html + route/index.txt.
    sidecarsFor: (primary) => [
      primary.replace(/\.html$/, ".txt"),
      primary.endsWith("/index.html") ? `${primary.slice(0, -"/index.html".length)}.txt` : "",
    ].filter(Boolean),
    // Pages Router _next/data housekeeping. Every `next build` mints a new
    // buildId, but visitors sit on HTML with OLDER buildIds baked in; their
    // client-side navigations fetch /_next/data/<theirBuildId>/route.json.
    // Without fan-out those requests would return stale props (or 404) for
    // pages rebuilt since. (_next/static/<buildId>/ manifests are tiny and
    // never pruned: old HTML still references them and chunks are handled by
    // assets gc.)
    finalizeOutDir: ({ outDir, stagingDir, deletedPageOutputs }) => {
      const created: string[] = [];
      const updated: string[] = [];
      const removals: string[] = [];
      const dataRoot = join(outDir, "_next", "data");
      const listIds = (): string[] =>
        existsSync(dataRoot)
          ? readdirSync(dataRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
          : [];

      // 1. Fan out this build's fresh JSON to every retained buildId dir
      //    (overwrite: the append-only asset merge skips existing files, which
      //    would strand stale props under a constant generateBuildId too).
      if (stagingDir) {
        const stagedData = join(stagingDir, "_next", "data");
        if (existsSync(stagedData)) {
          const targets = listIds();
          for (const newId of readdirSync(stagedData, { withFileTypes: true })) {
            if (!newId.isDirectory()) continue;
            const files: string[] = [];
            const walk = (dir: string, prefix: string) => {
              for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const rest = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.isDirectory()) walk(join(dir, entry.name), rest);
                else files.push(rest);
              }
            };
            walk(join(stagedData, newId.name), "");
            for (const id of new Set([...targets, newId.name])) {
              for (const rest of files) {
                const rel = `_next/data/${id}/${rest}`;
                const target = join(outDir, rel);
                const existed = existsSync(target);
                mkdirSync(dirname(target), { recursive: true });
                copyFileSync(join(stagedData, newId.name, rest), target);
                (existed ? updated : created).push(rel);
              }
            }
          }
        }
      }

      // 2. Deleted pages: drop their JSON from every retained buildId dir.
      for (const outputPath of deletedPageOutputs) {
        const rest = outputPath.endsWith("index.html")
          ? `${outputPath.slice(0, -"index.html".length).replace(/\/$/, "") || "index"}.json`
          : outputPath.replace(/\.html$/, ".json");
        for (const id of listIds()) removals.push(`_next/data/${id}/${rest}`);
      }

      // 3. Prune buildId data dirs beyond the retention window (oldest first;
      //    visitors on that old HTML degrade to full-page navigation).
      const ids = listIds()
        .map((id) => ({ id, mtime: statSync(join(dataRoot, id)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      for (const { id } of ids.slice(keepBuildIds)) {
        rmSync(join(dataRoot, id), { recursive: true, force: true });
      }

      return { created, updated, removals };
    },
  });
}
