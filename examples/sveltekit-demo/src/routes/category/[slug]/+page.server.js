import { hybldEntries, hybldData } from "@hybld/sveltekit";

export const entries = () => hybldEntries("category", (job) => ({ slug: job.item.slug }));

export const load = async ({ params }) => ({ category: await hybldData("category", { slug: params.slug }) });
