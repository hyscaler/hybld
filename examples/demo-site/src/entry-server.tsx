import { renderToString } from "react-dom/server";
import { PAGES } from "./pages.js";

const SITE = "Hybld Demo";
const SITE_URL = "https://demo.example.com";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stripHtml = (s: string) => s.replace(/<[^>]*>/g, "").trim();

export default function render({ route, pageType, data }: { route: string; pageType: string; data: any }) {
  const Page = PAGES[pageType];
  if (!Page) throw new Error(`Unknown page type: ${pageType}`);
  const html = renderToString(<Page {...data} />);

  const title =
    pageType === "article"
      ? `${data.title} | ${SITE}`
      : pageType === "category"
        ? `${data.name} | ${SITE}`
        : pageType === "notFound"
          ? `Not found | ${SITE}`
          : SITE;
  const description =
    pageType === "article" ? stripHtml(data.excerpt ?? "").slice(0, 155) : `Latest articles from ${SITE}.`;

  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}">`,
    `<link rel="canonical" href="${SITE_URL}${route}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:type" content="${pageType === "article" ? "article" : "website"}">`,
  ].join("\n    ");

  return { html, head };
}
