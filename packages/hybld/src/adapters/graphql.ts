import type { ArticleRef, CmsAdapter, ListOpts, ListResult } from "../types.js";
import { createFetcher, type Fetcher } from "../http.js";

interface GqlQuery {
  query: string;
  /** Extract the item array (or single item) from the response `data`. */
  pick: (data: any) => any;
  /** Report whether more pages exist. Default: items.length === perPage. */
  hasMore?: (data: any) => boolean;
}

export interface GraphqlAdapterOptions {
  name?: string;
  endpoint: string;
  headers?: Record<string, string>;
  /** Variables: { page, perPage } */
  list: GqlQuery;
  /** Variables: { id, slug } */
  item: GqlQuery;
  /** Variables: { since, page, perPage }. Optional. */
  modifiedSince?: GqlQuery;
  /** Variables: { taxonomy }. Optional. */
  terms?: GqlQuery;
  count?: { query: string; pick: (data: any) => number };
  concurrency?: number;
  requestsPerSecond?: number;
  fetcher?: Fetcher;
}

export function createGraphqlAdapter(opts: GraphqlAdapterOptions): CmsAdapter & { fetcher: Fetcher } {
  const fetcher =
    opts.fetcher ??
    createFetcher({
      concurrency: opts.concurrency,
      requestsPerSecond: opts.requestsPerSecond,
      headers: opts.headers,
    });

  const exec = async (query: string, variables: Record<string, unknown>): Promise<any> => {
    const res = await fetcher(opts.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`GraphQL error: ${json.errors[0].message}`);
    return json.data;
  };

  const runList = async (q: GqlQuery, variables: Record<string, unknown>, perPage: number): Promise<ListResult<any>> => {
    const data = await exec(q.query, variables);
    const items = q.pick(data) ?? [];
    const hasMore = q.hasMore ? q.hasMore(data) : items.length === perPage;
    return { items, hasMore };
  };

  const adapter: CmsAdapter & { fetcher: Fetcher } = {
    name: opts.name ?? "graphql",
    fetcher,

    async count() {
      if (opts.count) {
        const data = await exec(opts.count.query, {});
        return opts.count.pick(data);
      }
      throw new Error("This GraphQL adapter has no count query configured.");
    },

    listArticles(o: ListOpts) {
      return runList(opts.list, { page: o.page, perPage: o.perPage }, o.perPage);
    },

    async getArticle(ref: ArticleRef) {
      const data = await exec(opts.item.query, { id: ref.id ?? null, slug: ref.slug ?? null });
      return opts.item.pick(data) ?? null;
    },
  };

  if (opts.modifiedSince) {
    adapter.listModifiedSince = (date, o) =>
      runList(opts.modifiedSince!, { since: date.toISOString(), page: o.page, perPage: o.perPage }, o.perPage);
  }

  if (opts.terms) {
    adapter.listTerms = async (taxonomy) => {
      const data = await exec(opts.terms!.query, { taxonomy });
      return opts.terms!.pick(data) ?? [];
    };
  }

  return adapter;
}
