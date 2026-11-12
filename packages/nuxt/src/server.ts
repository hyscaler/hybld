// Server-only data access. Runs in Node during prerendering (and in the dev
// server); never import this from code that reaches the browser. Pages should
// use the auto-imported useHybldData() composable instead.
import { scopedData, scopedParams, type ScopeJob } from "hybld/scope";

export type { ScopeJob };

/** Data for one page: from the scope during hybld runs, through the hybld config otherwise. */
export function hybldData(
  pageType: string,
  ref?: { slug?: string; id?: string | number; page?: number }
): Promise<any> {
  return scopedData(pageType, ref);
}

/** Routes of a page type: scoped during hybld runs, the full catalog otherwise. */
export async function hybldRoutes(pageType: string): Promise<string[]> {
  return (await scopedParams(pageType)).map((job) => job.route);
}
