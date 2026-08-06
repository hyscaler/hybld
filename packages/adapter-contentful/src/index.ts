import { createRestAdapter, type CmsAdapter } from "hybld";

export interface ContentfulOptions {
  space: string;
  /** Delivery API access token. */
  accessToken: string;
  environment?: string;
  contentType: string;
  /** Field used for slug lookups. Default "slug". */
  slugField?: string;
  /** API host. Default https://cdn.contentful.com (use preview.contentful.com for drafts). */
  host?: string;
  concurrency?: number;
  requestsPerSecond?: number;
}

/**
 * Contentful Delivery API preset built on createRestAdapter. Uses skip/limit
 * (offset) pagination and sys.updatedAt filtering; entries are flattened to
 * { id, modified, ...fields } so hybld defaults work unchanged.
 */
export function contentful(opts: ContentfulOptions): CmsAdapter {
  const host = (opts.host ?? "https://cdn.contentful.com").replace(/\/+$/, "");
  const env = opts.environment ?? "master";
  const listUrl = `${host}/spaces/${opts.space}/environments/${env}/entries`;
  const slugField = opts.slugField ?? "slug";

  const flatten = (entry: any): any =>
    entry ? { id: entry.sys?.id, modified: entry.sys?.updatedAt, ...entry.fields } : null;

  return createRestAdapter({
    name: "contentful",
    listUrl,
    itemUrl: (ref) =>
      ref.id !== undefined
        ? `${listUrl}/${ref.id}`
        : `${listUrl}?content_type=${encodeURIComponent(opts.contentType)}&fields.${slugField}=${encodeURIComponent(ref.slug ?? "")}`,
    offsetParam: "skip",
    perPageParam: "limit",
    modifiedAfterParam: "sys.updatedAt[gt]",
    count: { pick: (json) => json?.total ?? 0 },
    query: { content_type: opts.contentType },
    pickList: (json) => (json?.items ?? []).map(flatten),
    pickItem: (json) => {
      if (json?.items) return json.items.length ? flatten(json.items[0]) : null;
      return json?.sys ? flatten(json) : null;
    },
    headers: { Authorization: `Bearer ${opts.accessToken}` },
    concurrency: opts.concurrency,
    requestsPerSecond: opts.requestsPerSecond,
  });
}
