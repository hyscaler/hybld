// Page-side helpers. This entry imports only `hybld/scope`, a lightweight
// module graph safe to bundle into Astro's SSR build (no vite, no workers).
// The render backend lives in "@hybld/astro/renderer" (hybld.config only).
import { scopedJobs, scopedData, type ScopeJob } from "hybld/scope";

export type { ScopeJob };

/**
 * For getStaticPaths: returns [{ params, props }] entries. Scoped during
 * hybld runs; full catalog on plain `astro build` or in dev.
 */
export async function hybldPaths(
  pageType: string,
  map: (data: any, job: ScopeJob) => { params: Record<string, string | number>; props?: Record<string, any> }
): Promise<Array<{ params: Record<string, string | number>; props?: Record<string, any> }>> {
  return (await scopedJobs(pageType)).map((job) => map(job.data, job));
}

/**
 * Data for a single page: scope-first, config-loader fallback. Use for static
 * routes (home) that Astro rebuilds on every run, and for one-off lookups.
 */
export function hybldData(pageType: string, ref?: { slug?: string; id?: string | number }): Promise<any> {
  return scopedData(pageType, ref);
}
