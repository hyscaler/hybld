import { createFetcher, type CmsAdapter, type Fetcher, type ListOpts, type ListResult } from "hybld";

export interface SanityOptions {
  projectId: string;
  dataset: string;
  /** Document _type to treat as articles. */
  type: string;
  /** API version date. Default "2024-01-01". */
  apiVersion?: string;
  /** Read token for private datasets. */
  token?: string;
  /** Use the CDN endpoint (cached, cheaper; slightly stale). Default true. */
  useCdn?: boolean;
  /** Override the API origin entirely (used in tests). */
  baseUrl?: string;
  concurrency?: number;
  requestsPerSecond?: number;
  /** Map a raw Sanity document to your article shape. Default flattens _id/_updatedAt/slug.current. */
  normalize?: (doc: any) => any;
}

/**
 * Sanity preset: a hand-written adapter (GROQ is a query language, not a REST
 * convention, so createRestAdapter does not fit). Documents are normalized to
 * { id, modified, slug, ...doc } so hybld defaults work unchanged.
 */
export function sanity(opts: SanityOptions): CmsAdapter & { fetcher: Fetcher } {
  const apiVersion = opts.apiVersion ?? "2024-01-01";
  const host =
    opts.baseUrl ??
    `https://${opts.projectId}.${opts.useCdn === false ? "api" : "apicdn"}.sanity.io`;
  const queryUrl = `${host}/v${apiVersion}/data/query/${opts.dataset}`;

  const fetcher = createFetcher({
    concurrency: opts.concurrency,
    requestsPerSecond: opts.requestsPerSecond,
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
    cacheBypass: (url) => url.includes("_updatedAt"),
  });

  const normalize =
    opts.normalize ??
    ((doc: any) =>
      doc
        ? { ...doc, id: doc._id, modified: doc._updatedAt, slug: doc.slug?.current ?? doc.slug }
        : null);

  const exec = async (groq: string, params: Record<string, unknown> = {}): Promise<any> => {
    const url = new URL(queryUrl);
    url.searchParams.set("query", groq);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`$${k}`, JSON.stringify(v));
    const res = await fetcher(url.toString());
    if (!res.ok) throw new Error(`Sanity query failed: ${res.status}`);
    const json = await res.json();
    return json.result;
  };

  const t = opts.type;
  const listSlice = async (filter: string, o: ListOpts, params: Record<string, unknown>): Promise<ListResult<any>> => {
    const start = (o.page - 1) * o.perPage;
    const result = await exec(`*[${filter}] | order(_id asc) [$start...$end]`, {
      ...params,
      start,
      end: start + o.perPage,
    });
    const items = (result ?? []).map(normalize);
    return { items, hasMore: items.length === o.perPage };
  };

  return {
    name: "sanity",
    fetcher,
    count: () => exec(`count(*[_type == $t])`, { t }),
    listArticles: (o) => listSlice(`_type == $t`, o, { t }),
    async getArticle(ref) {
      const doc =
        ref.id !== undefined
          ? await exec(`*[_id == $id][0]`, { id: ref.id })
          : await exec(`*[_type == $t && slug.current == $slug][0]`, { t, slug: ref.slug });
      return normalize(doc);
    },
    listModifiedSince: (date, o) =>
      listSlice(`_type == $t && _updatedAt > $since`, o, { t, since: date.toISOString() }),
  };
}
