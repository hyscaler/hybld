import { hybldEntries, hybldData } from "@hybld/sveltekit";

// Scoped during hybld runs (only the changed articles); the full catalog on a
// plain `vite build`.
export const entries = () => hybldEntries("article", (job) => ({ slug: job.slug }));

export const load = async ({ params }) => ({ article: await hybldData("article", { slug: params.slug }) });
