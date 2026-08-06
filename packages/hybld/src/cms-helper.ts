import type { CmsAdapter, CmsHelper, ListOpts } from "./types.js";

export function createCmsHelper(adapter: CmsAdapter, defaults: { perPage: number }): CmsHelper {
  return {
    async list(opts: Partial<ListOpts> = {}) {
      const res = await adapter.listArticles({ page: 1, perPage: defaults.perPage, ...opts });
      return res.items;
    },
    async listTerms(taxonomy: string) {
      if (!adapter.listTerms) {
        throw new Error(`Adapter "${adapter.name}" does not implement listTerms(); cannot enumerate taxonomy "${taxonomy}".`);
      }
      return adapter.listTerms(taxonomy);
    },
    getArticle(ref) {
      return adapter.getArticle(ref);
    },
    count() {
      return adapter.count();
    },
    raw: adapter,
  };
}
