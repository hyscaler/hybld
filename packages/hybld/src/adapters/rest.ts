import type { ArticleRef, CmsAdapter, ListOpts, ListResult, TermRef } from "../types.js";
import { createFetcher, type Fetcher } from "../http.js";

export interface RestAdapterOptions {
  name?: string;
  listUrl: string;
  /** Build the URL for a single item. Default: `${listUrl}/${id}` or `${listUrl}?slug=`. */
  itemUrl?: (ref: ArticleRef) => string;
  pageParam?: string;
  /** For offset-based APIs (Contentful-style skip/limit): used instead of pageParam, sent as (page-1)*perPage. */
  offsetParam?: string;
  perPageParam?: string;
  /** Omit if the API cannot filter by modification date. */
  modifiedAfterParam?: string;
  /** How to obtain the total item count: response header, dedicated endpoint, or picked from the list body. */
  count?: { header: string } | { url: string; pick: (json: any) => number } | { pick: (json: any) => number };
  headers?: Record<string, string>;
  /** Static query params appended to every list request. */
  query?: Record<string, string>;
  /** Extract the item array from the list response. Default: response body itself. */
  pickList?: (json: any) => any[];
  /** Extract a single item from the item response. Default: body, or first element if the body is an array. */
  pickItem?: (json: any) => any;
  /** Taxonomy support for aggregate pages. */
  termsUrl?: (taxonomy: string) => string;
  pickTerms?: (json: any) => TermRef[];
  /** URLs that must never be served from the disk cache. Defaults to modified-after and status=trash queries. */
  cacheBypass?: (url: string) => boolean;
  concurrency?: number;
  requestsPerSecond?: number;
  /** Provide a shared fetcher (used internally so all traffic shares one rate limit). */
  fetcher?: Fetcher;
}

export function createRestAdapter(opts: RestAdapterOptions): CmsAdapter & { fetcher: Fetcher } {
  const defaultBypass = (url: string) =>
    (opts.modifiedAfterParam ? url.includes(`${opts.modifiedAfterParam}=`) : false) || url.includes("status=trash");
  const fetcher =
    opts.fetcher ??
    createFetcher({
      concurrency: opts.concurrency,
      requestsPerSecond: opts.requestsPerSecond,
      headers: opts.headers,
      cacheBypass: opts.cacheBypass ?? defaultBypass,
    });
  const pageParam = opts.pageParam ?? "page";
  const perPageParam = opts.perPageParam ?? "per_page";
  const pickList = opts.pickList ?? ((json: any) => (Array.isArray(json) ? json : json.items ?? []));

  const listRequest = async (params: Record<string, string>): Promise<{ items: any[]; total: number | null }> => {
    const url = new URL(opts.listUrl);
    for (const [k, v] of Object.entries({ ...opts.query, ...params })) url.searchParams.set(k, v);
    const res = await fetcher(url.toString());
    if (!res.ok) throw new Error(`CMS list request failed: ${res.status} ${url}`);
    let total: number = NaN;
    if (opts.count && "header" in opts.count) total = Number(res.headers.get(opts.count.header) ?? NaN);
    const json = await res.json();
    if (opts.count && !("header" in opts.count) && !("url" in opts.count)) total = opts.count.pick(json);
    return { items: pickList(json), total: Number.isNaN(total) ? null : total };
  };

  const list = async (listOpts: ListOpts, extra: Record<string, string> = {}): Promise<ListResult<any>> => {
    const { page, perPage, ...filters } = listOpts;
    const params: Record<string, string> = { [perPageParam]: String(perPage), ...extra };
    if (opts.offsetParam) params[opts.offsetParam] = String((page - 1) * perPage);
    else params[pageParam] = String(page);
    for (const [k, v] of Object.entries(filters)) if (v !== undefined) params[k] = String(v);
    const { items, total } = await listRequest(params);
    const hasMore = total !== null ? page * perPage < total : items.length === perPage;
    return { items, hasMore };
  };

  const adapter: CmsAdapter & { fetcher: Fetcher } = {
    name: opts.name ?? "rest",
    fetcher,

    async count() {
      if (opts.count && "url" in opts.count) {
        const res = await fetcher(opts.count.url);
        if (!res.ok) throw new Error(`CMS count request failed: ${res.status}`);
        return opts.count.pick(await res.json());
      }
      const url = new URL(opts.listUrl);
      for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
      if (opts.offsetParam) url.searchParams.set(opts.offsetParam, "0");
      else url.searchParams.set(pageParam, "1");
      url.searchParams.set(perPageParam, "1");
      const res = await fetcher(url.toString());
      if (!res.ok) throw new Error(`CMS count request failed: ${res.status}`);
      if (opts.count && "header" in opts.count) {
        const total = Number(res.headers.get(opts.count.header));
        if (!Number.isNaN(total)) return total;
      }
      const json = await res.json();
      if (opts.count && "pick" in opts.count && !("url" in opts.count)) return opts.count.pick(json);
      return Array.isArray(json) ? json.length : (pickList(json)?.length ?? 0);
    },

    listArticles(o) {
      return list(o);
    },

    async getArticle(ref) {
      const url = opts.itemUrl
        ? opts.itemUrl(ref)
        : ref.id !== undefined
          ? `${opts.listUrl}/${ref.id}`
          : `${opts.listUrl}?slug=${encodeURIComponent(ref.slug ?? "")}`;
      const res = await fetcher(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`CMS item request failed: ${res.status} ${url}`);
      const json = await res.json();
      if (opts.pickItem) return opts.pickItem(json) ?? null;
      if (Array.isArray(json)) return json[0] ?? null;
      return json ?? null;
    },
  };

  if (opts.modifiedAfterParam) {
    adapter.listModifiedSince = (date, o) =>
      list(o, { [opts.modifiedAfterParam as string]: date.toISOString() });
  }

  if (opts.termsUrl) {
    adapter.listTerms = async (taxonomy) => {
      const res = await fetcher(opts.termsUrl!(taxonomy));
      if (!res.ok) throw new Error(`CMS terms request failed: ${res.status}`);
      const json = await res.json();
      return opts.pickTerms ? opts.pickTerms(json) : (json as TermRef[]);
    };
  }

  return adapter;
}
