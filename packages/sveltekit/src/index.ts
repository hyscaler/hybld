// Page-side helpers for +page.server.js files. This entry imports only
// `hybld/scope`, a lightweight module graph that runs in Node at build time.
// The render backend lives in "@hybld/sveltekit/renderer" (hybld.config only).
import { scopedParams, scopedData, type ScopeJob } from "hybld/scope";

export type { ScopeJob };

/**
 * For a dynamic route's `entries` export: returns the params objects to
 * prerender. Scoped during hybld runs (only the changed pages); the full
 * catalog on a plain `vite build`. Derive params from job fields: `data` is
 * undefined on plain builds, where loading it would cost one call per page.
 */
export async function hybldEntries<P extends Record<string, string>>(
  pageType: string,
  map: (job: ScopeJob) => P
): Promise<P[]> {
  return (await scopedParams(pageType)).map((job) => map(job));
}

/**
 * Data for one page, for `load` in +page.server.js: read from the scope during
 * hybld runs, loaded through the hybld config otherwise (plain builds, dev).
 */
export function hybldData(
  pageType: string,
  ref?: { slug?: string; id?: string | number; page?: number }
): Promise<any> {
  return scopedData(pageType, ref);
}
