import React from "react";
import { renderToString } from "react-dom/server";
import { PAGES } from "./pages";

const esc = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const strip = (s: string) => String(s ?? "").replace(/<[^>]+>/g, "").trim();

export default function render({ route, pageType, data }: { route: string; pageType: string; data: any }) {
  const Page = PAGES[pageType];
  if (!Page) throw new Error(`No component for page type "${pageType}"`);
  const html = renderToString(<Page {...data} />);
  const head = [
    `<title>${esc(strip(data.title ?? "hybld starter"))}</title>`,
    `<meta name="description" content="${esc(strip(data.excerpt ?? "").slice(0, 150))}">`,
    `<meta name="robots" content="noindex">`, // demo content; drop for your own site
  ].join("\n    ");
  return { html, head };
}
