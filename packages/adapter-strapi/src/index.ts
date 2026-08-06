import { createRestAdapter, type CmsAdapter } from "hybld";

export interface StrapiOptions {
  /** Strapi origin, e.g. https://cms.example.com */
  baseUrl: string;
  /** Plural API id of the content type, e.g. "articles". */
  contentType: string;
  /** API token (Settings -> API Tokens). */
  token?: string;
  /** Field used for slug lookups. Default "slug". */
  slugField?: string;
  concurrency?: number;
  requestsPerSecond?: number;
  /** Extra query params for list requests (e.g. { populate: "*" }). */
  query?: Record<string, string>;
}

/**
 * Strapi preset built on createRestAdapter. Handles both v4 (data[].attributes)
 * and v5 (flat documents) response shapes; `modified` is normalized from
 * updatedAt so incremental diffing works with hybld defaults.
 */
export function strapi(opts: StrapiOptions): CmsAdapter {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const listUrl = `${base}/api/${opts.contentType}`;
  const slugField = opts.slugField ?? "slug";

  const normalize = (entry: any): any => {
    if (!entry) return null;
    const flat = entry.attributes ? { id: entry.id, ...entry.attributes } : entry;
    return { ...flat, modified: flat.updatedAt ?? flat.modified };
  };

  return createRestAdapter({
    name: "strapi",
    listUrl,
    itemUrl: (ref) =>
      ref.id !== undefined
        ? `${listUrl}/${ref.id}`
        : `${listUrl}?filters[${slugField}][$eq]=${encodeURIComponent(ref.slug ?? "")}`,
    pageParam: "pagination[page]",
    perPageParam: "pagination[pageSize]",
    modifiedAfterParam: "filters[updatedAt][$gt]",
    count: { pick: (json) => json?.meta?.pagination?.total ?? 0 },
    pickList: (json) => (json?.data ?? []).map(normalize),
    pickItem: (json) => {
      const d = json?.data;
      if (Array.isArray(d)) return d.length ? normalize(d[0]) : null;
      return d ? normalize(d) : null;
    },
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
    query: opts.query,
    concurrency: opts.concurrency,
    requestsPerSecond: opts.requestsPerSecond,
  });
}
