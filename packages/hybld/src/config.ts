// NOTE: this module must stay lightweight (no imports that reach vite or
// worker_threads): it is part of the `hybld/scope` graph that framework
// helpers pull into Next/Astro server bundles. The default renderer is
// therefore resolved lazily in the Builder, not here.
import { resolve, dirname, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { ResolvedConfig, HybldConfig } from "./types.js";

export function defineConfig(config: HybldConfig): HybldConfig {
  return config;
}

const CONFIG_NAMES = ["hybld.config.ts", "hybld.config.mts", "hybld.config.js", "hybld.config.mjs"];

export async function loadConfig(configFile?: string, cwd = process.cwd()): Promise<ResolvedConfig> {
  let file = configFile ? (isAbsolute(configFile) ? configFile : resolve(cwd, configFile)) : undefined;
  if (!file) {
    file = CONFIG_NAMES.map((n) => resolve(cwd, n)).find((p) => existsSync(p));
  }
  if (!file || !existsSync(file)) {
    throw new Error(`hybld config not found${configFile ? `: ${configFile}` : ` in ${cwd} (looked for ${CONFIG_NAMES.join(", ")})`}`);
  }

  // Prefer Node's native import (Node >= 23.6 strips erasable TS syntax);
  // jiti is the fallback for older Nodes and non-erasable TS. jiti must be
  // loaded lazily: framework build workers (Next) bundle it if it appears as
  // a static import in this graph, and the bundled copy breaks.
  let mod: any;
  try {
    mod = await import(`${new URL(`file://${file}`).href}?t=${Date.now()}`);
  } catch {
    const { createJiti } = await import("jiti");
    const jiti = createJiti(import.meta.url);
    mod = await jiti.import(file);
  }
  const raw: HybldConfig = mod.default ?? mod;
  return validateConfig(raw, dirname(file), file);
}

export function validateConfig(raw: HybldConfig, configDir: string, configFile?: string): ResolvedConfig {
  const problems: string[] = [];
  if (!raw || typeof raw !== "object") problems.push("config must export a defineConfig(...) object as default");
  if (!raw.adapter) problems.push("`adapter` is required (use createRestAdapter/createGraphqlAdapter or a preset)");
  else {
    for (const method of ["count", "listArticles", "getArticle"] as const) {
      if (typeof (raw.adapter as any)[method] !== "function") problems.push(`adapter is missing required method \`${method}\``);
    }
  }
  if (!raw.pages || Object.keys(raw.pages).length === 0) problems.push("`pages` must declare at least one page type");
  for (const [name, page] of Object.entries(raw.pages ?? {})) {
    if (!page) continue;
    if (typeof (page as any).route !== "function") problems.push(`pages.${name}.route must be a function`);
    if (typeof (page as any).data !== "function") problems.push(`pages.${name}.data must be a function`);
  }
  if (raw.feed?.enabled && !(raw.feed.baseUrl ?? raw.sitemap?.baseUrl)) {
    problems.push("feed.enabled requires feed.baseUrl (or sitemap.baseUrl)");
  }
  if (raw.images && (!Array.isArray(raw.images.origins) || raw.images.origins.length === 0)) {
    problems.push("images.origins must be a non-empty array of origins to localize");
  }
  const opt = raw.images?.optimize;
  if (opt) {
    if (opt.maxWidth !== undefined && !(Number.isInteger(opt.maxWidth) && opt.maxWidth > 0)) {
      problems.push("images.optimize.maxWidth must be a positive integer");
    }
    if (opt.format !== undefined && !["webp", "avif", "original"].includes(opt.format)) {
      problems.push('images.optimize.format must be "webp", "avif" or "original"');
    }
    if (opt.quality !== undefined && !(opt.quality >= 1 && opt.quality <= 100)) {
      problems.push("images.optimize.quality must be between 1 and 100");
    }
  }
  const batchSize = raw.render?.batchSize;
  if (batchSize !== undefined && !(Number.isInteger(batchSize) && batchSize > 0)) {
    problems.push("render.batchSize must be a positive integer");
  }
  if (problems.length) {
    throw new Error(`Invalid hybld config:\n  - ${problems.join("\n  - ")}`);
  }

  const root = raw.root ? resolve(configDir, raw.root) : configDir;
  return {
    adapter: raw.adapter,
    renderer: raw.renderer,
    root,
    configDir,
    configFile: configFile ?? null,
    outDir: resolve(root, raw.outDir ?? "dist"),
    basePath: raw.basePath ?? "/",
    manifest: resolve(root, raw.manifest ?? ".hybld/manifest.db"),
    manifestBackup:
      raw.manifestBackup === false ? null : { everyMinutes: Math.max(0, raw.manifestBackup?.everyMinutes ?? 60) },
    render: {
      entry: resolve(root, raw.render?.entry ?? "src/entry-server.tsx"),
      template: resolve(root, raw.render?.template ?? "index.html"),
      workers: raw.render?.workers ?? 4,
      timeout: raw.render?.timeout ?? 60_000,
      batchSize: raw.render?.batchSize,
    },
    cms: {
      concurrency: raw.cms?.concurrency ?? 4,
      perPage: raw.cms?.perPage ?? 100,
      requestsPerSecond: raw.cms?.requestsPerSecond,
      cache: !raw.cms?.cache
        ? false
        : { ttlSeconds: (typeof raw.cms.cache === "object" ? raw.cms.cache.ttlSeconds : undefined) ?? 300 },
    },
    pages: raw.pages,
    sitemap: raw.sitemap ?? { enabled: false },
    feed: {
      enabled: raw.feed?.enabled ?? false,
      baseUrl: raw.feed?.baseUrl ?? raw.sitemap?.baseUrl,
      title: raw.feed?.title ?? "Feed",
      description: raw.feed?.description ?? "",
      limit: raw.feed?.limit ?? 20,
      item: raw.feed?.item,
    },
    redirects: { file: resolve(root, raw.redirects?.file ?? ".hybld/redirects.json") },
    emitData: raw.emitData ?? false,
    images: raw.images
      ? {
          origins: raw.images.origins,
          dir: raw.images.dir ?? "media",
          optimize: raw.images.optimize
            ? {
                maxWidth: raw.images.optimize.maxWidth ?? 1600,
                format: raw.images.optimize.format ?? "webp",
                quality: raw.images.optimize.quality ?? 80,
              }
            : null,
        }
      : null,
    preview: { pathPrefix: raw.preview?.pathPrefix ?? "/_preview" },
  };
}
