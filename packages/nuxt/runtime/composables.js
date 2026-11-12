import { useAsyncData } from "#imports";

/**
 * Page data from hybld. During prerendering it reads this run's scope (or
 * loads through the hybld config on plain builds); in the browser the
 * prerendered payload already carries the result, so nothing is fetched.
 */
export function useHybldData(pageType, ref) {
  return useAsyncData(`hybld:${pageType}:${JSON.stringify(ref ?? {})}`, async () => {
    if (import.meta.server) {
      const { hybldData } = await import("@hybld/nuxt/server");
      return hybldData(pageType, ref);
    }
    if (import.meta.dev) {
      return $fetch("/__hybld/data", { query: { type: pageType, ref: JSON.stringify(ref ?? {}) } });
    }
    throw new Error(
      `hybld: no prerendered data for page type "${pageType}". This page was not built by hybld; rebuild it or check that the route is prerendered.`
    );
  });
}
