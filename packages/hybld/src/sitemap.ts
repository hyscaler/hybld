import type { Manifest } from "./manifest.js";
import type { OutputWriter } from "./output.js";

const SHARD_SIZE = 50_000;

/**
 * Sharded incremental sitemap (FR-10): index + shard files regenerated from
 * the manifest; only shards whose content changed are rewritten.
 */
export function writeSitemap(
  manifest: Manifest,
  writer: OutputWriter,
  baseUrl: string
): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  const written: string[] = [];
  let shardCount = 0;
  const flush = (urls: string[]) => {
    const file = `sitemap-${shardCount++}.xml`;
    // The xhtml namespace is declared only when a shard carries hreflang
    // links, so single-language sitemaps stay byte-identical.
    const ns = urls.some((u) => u.includes("<xhtml:link")) ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : "";
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${ns}>\n${urls.join("\n")}\n</urlset>\n`;
    if (writer.writeIfChanged(file, xml)) written.push(file);
  };

  // Rows stream from the manifest in route order; only one shard's worth of
  // lines is held at a time.
  let urls: string[] = [];
  for (const r of manifest.sitemapRows()) {
    if (r.route.endsWith(".html")) continue;
    const links = alternateLinks(r.alternatesRef, base);
    urls.push(`  <url><loc>${base}${escapeXml(r.route)}</loc><lastmod>${r.lastmod.slice(0, 10)}</lastmod>${links}</url>`);
    if (urls.length === SHARD_SIZE) {
      flush(urls);
      urls = [];
    }
  }
  if (urls.length > 0) flush(urls);

  // A shrinking catalog leaves shard files beyond the new count; delete them
  // so stale URLs are not left crawlable on disk.
  for (let i = shardCount; ; i++) {
    const file = `sitemap-${i}.xml`;
    const before = writer.deletedFiles.length;
    writer.deletePage(file);
    if (writer.deletedFiles.length === before) break;
  }

  const entries = Array.from({ length: shardCount }, (_, i) => `  <sitemap><loc>${base}/sitemap-${i}.xml</loc></sitemap>`);
  const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</sitemapindex>\n`;
  if (writer.writeIfChanged("sitemap.xml", index)) written.push("sitemap.xml");
  return written;
}

/** hreflang alternates for one URL, from the manifest's stored language versions. */
function alternateLinks(alternatesRef: string | null | undefined, base: string): string {
  if (!alternatesRef) return "";
  try {
    const alts = JSON.parse(alternatesRef) as Array<{ lang: string; route: string }>;
    return alts
      .map((a) => `<xhtml:link rel="alternate" hreflang="${escapeXml(a.lang)}" href="${base}${escapeXml(a.route)}"/>`)
      .join("");
  } catch {
    return "";
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
