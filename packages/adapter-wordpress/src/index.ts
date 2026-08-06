import { createRestAdapter, type CmsAdapter } from "hybld";

export interface WordpressOptions {
  /** Site origin, e.g. https://cms.example.com */
  baseUrl: string;
  /** REST post type collection, default "posts". */
  postType?: string;
  auth?: { token?: string; basic?: { user: string; password: string } };
  concurrency?: number;
  requestsPerSecond?: number;
  /** Extra query params for list requests (e.g. { _embed: "1" }). */
  query?: Record<string, string>;
  /**
   * Implement listDeletedSince via `?status=trash&modified_after=` so `--since`
   * builds process deletions. Real WordPress requires an authenticated user
   * with edit permission for status=trash queries.
   */
  trackDeletes?: boolean;
}

/**
 * WordPress preset: a thin layer over createRestAdapter wiring WordPress REST
 * conventions (`modified_after`, `X-WP-Total`, `_embed`, taxonomy endpoints).
 */
export function wordpress(opts: WordpressOptions): CmsAdapter {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const postType = opts.postType ?? "posts";
  const api = `${base}/wp-json/wp/v2`;

  const headers: Record<string, string> = {};
  if (opts.auth?.token) headers.Authorization = `Bearer ${opts.auth.token}`;
  else if (opts.auth?.basic) {
    headers.Authorization = `Basic ${Buffer.from(`${opts.auth.basic.user}:${opts.auth.basic.password}`).toString("base64")}`;
  }

  const taxonomyPath = (taxonomy: string) =>
    taxonomy === "category" ? "categories" : taxonomy === "post_tag" ? "tags" : taxonomy;

  const adapter = createRestAdapter({
    name: "wordpress",
    listUrl: `${api}/${postType}`,
    itemUrl: (ref) =>
      ref.id !== undefined
        ? `${api}/${postType}/${ref.id}`
        : `${api}/${postType}?slug=${encodeURIComponent(ref.slug ?? "")}`,
    pageParam: "page",
    perPageParam: "per_page",
    modifiedAfterParam: "modified_after",
    count: { header: "X-WP-Total" },
    headers,
    query: opts.query,
    termsUrl: (taxonomy) => `${api}/${taxonomyPath(taxonomy)}?per_page=100`,
    pickTerms: (json) => (json as any[]).map((t) => ({ id: t.id, slug: t.slug, name: t.name, count: t.count })),
    concurrency: opts.concurrency,
    requestsPerSecond: opts.requestsPerSecond,
  });

  // Draft previews via status=any (real WordPress requires an authenticated
  // user with edit permission for non-public statuses).
  adapter.getPreview = async (ref) => {
    const url =
      ref.id !== undefined
        ? `${api}/${postType}/${ref.id}?status=any`
        : `${api}/${postType}?slug=${encodeURIComponent(ref.slug ?? "")}&status=any&per_page=1`;
    const res = await (adapter as any).fetcher(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WordPress preview request failed: ${res.status} (status=any requires authentication on real WordPress)`);
    const json = await res.json();
    return Array.isArray(json) ? (json[0] ?? null) : (json ?? null);
  };

  if (opts.trackDeletes) {
    adapter.listDeletedSince = async (date) => {
      // Paginated: a bulk cleanup can trash far more than one page's worth,
      // and missing any of them would leave orphaned pages published.
      const out: Array<{ id: any; slug: any }> = [];
      // Backstop against an API that ignores &page and returns full pages
      // forever; 10k pages of trash since one build is not a real scenario.
      const MAX_PAGES = 10_000;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = `${api}/${postType}?status=trash&modified_after=${encodeURIComponent(date.toISOString())}&per_page=100&page=${page}`;
        const res = await (adapter as any).fetcher(url);
        // WordPress 400s with rest_post_invalid_page_number past the last page.
        if (res.status === 400 && page > 1) break;
        if (!res.ok) throw new Error(`WordPress trash query failed: ${res.status} (status=trash requires authentication on real WordPress)`);
        const items = (await res.json()) as any[];
        out.push(...items.map((p) => ({ id: p.id, slug: p.slug })));
        // Stop on a short page (last page) or when the header says we are at
        // the last page. A short page is the reliable signal; the header is a
        // shortcut when present (real WordPress always sets it), but its
        // absence must NOT stop us early while full pages keep coming back.
        const totalPages = Number(res.headers.get("x-wp-totalpages"));
        if (items.length < 100 || (Number.isFinite(totalPages) && page >= totalPages)) break;
      }
      return out;
    };
  }

  return adapter;
}
