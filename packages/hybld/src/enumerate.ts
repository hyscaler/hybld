import { createCmsHelper } from "./cms-helper.js";
import type { AggregatePageConfig, CollectionPageConfig, LoaderCtx, ResolvedConfig } from "./types.js";

export interface EnumeratedJob {
  route: string;
  pageType: string;
  data: any;
  slug?: string | null;
  id?: string | null;
  item?: any;
  page?: number;
}

function isCollection(name: string, page: any): boolean {
  return page && (page.collection === true || (name === "article" && !page.enumerate));
}

function ctxFor(config: ResolvedConfig): LoaderCtx {
  return { cms: createCmsHelper(config.adapter, { perPage: config.cms.perPage }) };
}

// Short-lived memo for full-catalog enumerations. Plain framework builds call
// the helpers once per page (Pages Router getStaticProps, per-page metadata);
// without this, every call re-walks the whole CMS catalog. The TTL keeps dev
// servers reasonably fresh without a restart.
const ENUM_TTL_MS = 60_000;
const enumMemo = new Map<string, { at: number; value: Promise<any> }>();
function memo<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = enumMemo.get(key);
  if (hit && Date.now() - hit.at < ENUM_TTL_MS) return hit.value as Promise<T>;
  const value = compute();
  enumMemo.set(key, { at: Date.now(), value });
  value.catch(() => enumMemo.delete(key));
  return value;
}

async function listCatalog(config: ResolvedConfig, pageType: string, cfg: CollectionPageConfig): Promise<any[]> {
  return memo(`catalog:${config.configDir}:${pageType}`, async () => {
    const adapter = cfg.adapter ?? config.adapter;
    const out: any[] = [];
    let prevFirst: string | null = null;
    for (let p = 1; ; p++) {
      const res = await adapter.listArticles({ page: p, perPage: config.cms.perPage });
      // Guard against a CMS that ignores the page param (infinite loop).
      const first = res.items.length > 0 ? JSON.stringify(res.items[0]).slice(0, 500) : null;
      if (p > 1 && first !== null && first === prevFirst) {
        throw new Error(`CMS adapter returned identical consecutive pages (page ${p}); aborting enumeration.`);
      }
      prevFirst = first;
      out.push(...res.items);
      if (!res.hasMore || res.items.length === 0) break;
    }
    return out;
  });
}

function enumerateItems(config: ResolvedConfig, pageType: string, agg: AggregatePageConfig): Promise<any[]> {
  return memo(`enumerate:${config.configDir}:${pageType}`, () => Promise.resolve(agg.enumerate!(ctxFor(config))));
}

/**
 * Framework-helper support: enumerate every page of a type with its data,
 * used by @hybld/next and @hybld/astro when no scope file is present
 * (plain `next build` / `astro build` / dev mode).
 */
export async function listJobsForType(config: ResolvedConfig, pageType: string): Promise<EnumeratedJob[]> {
  return listForType(config, pageType, true);
}

/**
 * Like listJobsForType but WITHOUT loading page data (`data` is undefined):
 * params enumeration (Next generateStaticParams/getStaticPaths) only needs
 * routes/slugs/ids, and loading data here would cost one data() call per
 * catalog page on plain framework builds.
 */
export async function listParamsForType(config: ResolvedConfig, pageType: string): Promise<EnumeratedJob[]> {
  return listForType(config, pageType, false);
}

async function listForType(config: ResolvedConfig, pageType: string, withData: boolean): Promise<EnumeratedJob[]> {
  const page = config.pages[pageType];
  if (!page) throw new Error(`Unknown page type "${pageType}" in hybld config`);

  if (isCollection(pageType, page)) {
    const cfg = page as CollectionPageConfig;
    const jobs: EnumeratedJob[] = [];
    for (const a of await listCatalog(config, pageType, cfg)) {
      jobs.push({
        route: cfg.route(a),
        pageType,
        data: withData ? await cfg.data(a) : undefined,
        slug: (cfg.slug ? cfg.slug(a) : a.slug) ?? null,
        id: String(cfg.id ? cfg.id(a) : a.id),
      });
    }
    return jobs;
  }

  const agg = page as AggregatePageConfig;
  const ctx = ctxFor(config);
  if (!agg.enumerate) {
    return [{ route: agg.route(), pageType, data: withData ? await agg.data(ctx) : undefined, page: 1 }];
  }
  const jobs: EnumeratedJob[] = [];
  for (const item of await enumerateItems(config, pageType, agg)) {
    const total = agg.pageCount
      ? Math.max(1, await agg.pageCount(item, ctx))
      : agg.paginate && typeof item?.count === "number"
        ? Math.max(1, Math.ceil(item.count / agg.paginate.perPage))
        : 1;
    for (let p = 1; p <= total; p++) {
      jobs.push({
        route: agg.route(item, p),
        pageType,
        data: withData ? await agg.data(item, p, ctx) : undefined,
        item,
        page: p,
      });
    }
  }
  return jobs;
}

/** Load the data for one page of a type (single article by ref, or a singleton/enumerated aggregate). */
export async function loadJobData(
  config: ResolvedConfig,
  pageType: string,
  ref?: { slug?: string; id?: string | number; page?: number }
): Promise<any> {
  const page = config.pages[pageType];
  if (!page) throw new Error(`Unknown page type "${pageType}" in hybld config`);

  if (isCollection(pageType, page)) {
    const cfg = page as CollectionPageConfig;
    const adapter = cfg.adapter ?? config.adapter;
    if (!ref) throw new Error(`loadJobData("${pageType}") needs a { slug } or { id } ref for collection types`);
    const article = await adapter.getArticle(ref);
    return article ? cfg.data(article) : null;
  }
  const agg = page as AggregatePageConfig;
  const ctx = ctxFor(config);
  if (agg.enumerate) {
    if (!ref) throw new Error(`loadJobData("${pageType}") needs a { slug } or { id } ref for enumerated aggregates`);
    const items = await enumerateItems(config, pageType, agg);
    const item = items.find(
      (i: any) =>
        (ref.slug !== undefined && String(i.slug) === String(ref.slug)) ||
        (ref.id !== undefined && String(i.id) === String(ref.id))
    );
    return item ? agg.data(item, ref.page ?? 1, ctx) : null;
  }
  return agg.data(ctx);
}
