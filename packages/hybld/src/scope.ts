import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { listJobsForType, listParamsForType, loadJobData, type EnumeratedJob } from "./enumerate.js";
import type { ResolvedConfig } from "./types.js";

/**
 * Framework-side scope access, shared by @hybld/next and @hybld/astro.
 *
 * When the hybld engine runs a delegated build it sets HYBLD_SCOPE to an
 * NDJSON file listing exactly the pages (and their prefetched data) for this
 * run. When absent (plain `next build` / `astro build`, dev servers), helpers
 * fall back to enumerating the full catalog through the hybld config.
 */

export interface ScopeJob extends EnumeratedJob {}

let scopeCache: ScopeJob[] | null | undefined;
let configCache: Promise<ResolvedConfig> | undefined;

export function readScope(): ScopeJob[] | null {
  if (scopeCache !== undefined) return scopeCache;
  const path = process.env.HYBLD_SCOPE;
  if (!path || !existsSync(path)) {
    scopeCache = null;
    return null;
  }
  scopeCache = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return scopeCache;
}

function ownConfig(): Promise<ResolvedConfig> {
  configCache ??= loadConfig(process.env.HYBLD_CONFIG, process.cwd());
  return configCache;
}

/** All pages of a type: scoped jobs during a hybld run, full catalog otherwise. */
export async function scopedJobs(pageType: string): Promise<ScopeJob[]> {
  const scope = readScope();
  if (scope) return scope.filter((j) => j.pageType === pageType);
  return listJobsForType(await ownConfig(), pageType);
}

/**
 * Like scopedJobs, but the fallback path skips loading page data (`data` is
 * undefined outside hybld runs). For params enumeration, where loading data
 * would cost one data() call per catalog page on plain framework builds.
 */
export async function scopedParams(pageType: string): Promise<ScopeJob[]> {
  const scope = readScope();
  if (scope) return scope.filter((j) => j.pageType === pageType);
  return listParamsForType(await ownConfig(), pageType);
}

/** Data for one page: from the scope when present, else loaded through the config. */
export async function scopedData(
  pageType: string,
  ref?: { slug?: string; id?: string | number; page?: number }
): Promise<any> {
  const scope = readScope();
  if (scope) {
    const hit = scope.find((j) => {
      if (j.pageType !== pageType) return false;
      if (ref === undefined) return true;
      if (ref.page !== undefined && j.page !== ref.page) return false;
      if (ref.slug !== undefined) return j.slug === ref.slug || String(j.item?.slug ?? "") === ref.slug;
      if (ref.id !== undefined) return String(j.id) === String(ref.id) || String(j.item?.id ?? "") === String(ref.id);
      return true;
    });
    if (hit) return hit.data;
    // Not in this run's scope (e.g. a static home page the framework rebuilds
    // anyway): load fresh data through the config so the page stays correct.
  }
  return loadJobData(await ownConfig(), pageType, ref);
}
