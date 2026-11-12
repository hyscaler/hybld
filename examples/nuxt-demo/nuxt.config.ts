// `nuxi generate` writes into .output/public; hybld merges those pages into
// its own cumulative outDir (`site`, see hybld.config.ts).
export default defineNuxtConfig({
  compatibilityDate: "2026-01-01",
  modules: ["@hybld/nuxt"],
  telemetry: false,
});
