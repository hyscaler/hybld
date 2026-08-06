// Page-side helpers. The hybld scope module is loaded via a dynamic import
// marked webpackIgnore so Next's bundler NEVER processes the hybld module
// graph: it resolves natively in Node at build time, in every Next phase
// (page-data collection, static generation workers, dev). Belt-and-braces:
// also add "hybld" and "@hybld/next" to `serverExternalPackages`.
// The render backend lives in "@hybld/next/renderer" (hybld.config only).

export interface ScopeJob {
  route: string;
  pageType: string;
  data: any;
  slug?: string | null;
  id?: string | null;
  item?: any;
  page?: number;
}

let scopeModule: Promise<any> | undefined;
function scope(): Promise<any> {
  scopeModule ??= import(/* webpackIgnore: true */ "hybld/scope");
  return scopeModule;
}

/**
 * For generateStaticParams: returns the params list. Scoped during hybld
 * runs; full catalog on plain `next build` or in dev.
 *
 * Derive params from `job` fields (slug/id/item/page). The `data` argument is
 * populated during scoped hybld runs but is undefined on plain builds:
 * loading page data during params enumeration would cost one CMS data() call
 * per catalog page there. Pages get their data via hybldData instead.
 */
export async function hybldParams(
  pageType: string,
  map: (data: any, job: ScopeJob) => Record<string, string | string[]>
): Promise<Array<Record<string, string | string[]>>> {
  const { scopedParams } = await scope();
  return (await scopedParams(pageType)).map((job: ScopeJob) => map(job.data, job));
}

/**
 * Data for one page: scope-first (no extra CMS call during hybld runs),
 * config-loader fallback otherwise. Use in server components and
 * generateMetadata. Pass `page` for paginated aggregate pages.
 */
export async function hybldData(
  pageType: string,
  ref?: { slug?: string; id?: string | number; page?: number }
): Promise<any> {
  const { scopedData } = await scope();
  return scopedData(pageType, ref);
}
