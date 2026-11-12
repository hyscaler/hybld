import { defineEventHandler, getQuery } from "h3";
import { hybldData } from "@hybld/nuxt/server";

// Dev-server only: serves page data to client-side navigations.
export default defineEventHandler((event) => {
  const { type, ref } = getQuery(event);
  return hybldData(String(type), ref ? JSON.parse(String(ref)) : undefined);
});
