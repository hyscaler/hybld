import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface HybldNuxtOptions {
  /**
   * Extra routes to prerender on every hybld run, beyond the scoped pages
   * and Nuxt's own static pages (for example "/200.html" style fallbacks).
   */
  alwaysPrerender?: string[];
}

/** Routes hybld scoped for this run, or null outside a hybld run. */
function scopeRoutes(): string[] | null {
  const path = process.env.HYBLD_SCOPE;
  if (!process.env.HYBLD_INTERNAL || !path || !existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).route as string);
}

/**
 * Nuxt module for hybld. Add it to `modules` in nuxt.config:
 *
 * - registers the `useHybldData()` composable as an auto-import;
 * - during hybld runs, prerenders exactly the scoped routes and switches the
 *   link crawler off, so one changed article does not rebuild the catalog;
 * - marks every route as prerendered and turns the app manifest off (it
 *   lists only the routes of the latest build, which is wrong for a site
 *   assembled from many scoped builds), so client-side navigation reads
 *   each page's extracted payload.
 */
export default function hybldNuxtModule(inlineOptions: HybldNuxtOptions | undefined, nuxt: any): void {
  const options: HybldNuxtOptions = { ...(nuxt.options.hybld ?? {}), ...(inlineOptions ?? {}) };
  const runtime = (file: string) => fileURLToPath(new URL(`../runtime/${file}`, import.meta.url));

  nuxt.options.experimental = { ...(nuxt.options.experimental ?? {}), appManifest: false };

  // Every page of the deployed site is prerendered, whichever build made it.
  // This rule is what makes client-side navigation read a page's extracted
  // _payload.json instead of running its data loaders in the browser.
  const rules = (nuxt.options.routeRules = nuxt.options.routeRules ?? {});
  rules["/**"] = { prerender: true, ...(rules["/**"] ?? {}) };

  // The composable ships as source so Nuxt compiles it with the app; its
  // server branch is dropped from the client bundle.
  nuxt.options.build.transpile = [...(nuxt.options.build.transpile ?? []), "@hybld/nuxt/runtime"];
  nuxt.hook("imports:extend", (imports: any[]) => {
    imports.push({ name: "useHybldData", from: runtime("composables.js") });
  });

  // Dev server: the browser has no prerendered payload to read, so client
  // navigations fetch page data from this endpoint instead.
  if (nuxt.options.dev) {
    nuxt.hook("nitro:config", (nitroConfig: any) => {
      nitroConfig.handlers = nitroConfig.handlers ?? [];
      nitroConfig.handlers.push({ route: "/__hybld/data", handler: runtime("dev-handler.js") });
    });
  }

  const routes = scopeRoutes();
  if (!routes) return; // plain `nuxi generate` or dev: Nuxt crawls the full site as usual

  nuxt.hook("nitro:config", (nitroConfig: any) => {
    nitroConfig.prerender = nitroConfig.prerender ?? {};
    nitroConfig.prerender.crawlLinks = false;
    nitroConfig.prerender.routes = [
      ...new Set([...(nitroConfig.prerender.routes ?? []), ...routes, ...(options.alwaysPrerender ?? [])]),
    ];
  });
}
