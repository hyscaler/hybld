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
  const rows = manifest
    .all()
    .filter((r) => !r.route.endsWith(".html"))
    .sort((a, b) => (a.route < b.route ? -1 : 1));

  const base = baseUrl.replace(/\/+$/, "");
  const shards: string[][] = [];
  for (let i = 0; i < rows.length; i += SHARD_SIZE) {
    shards.push(
      rows.slice(i, i + SHARD_SIZE).map((r) => {
        const lastmod = (r.cmsModifiedAt ?? r.builtAt).slice(0, 10);
        return `  <url><loc>${base}${escapeXml(r.route)}</loc><lastmod>${lastmod}</lastmod></url>`;
      })
    );
  }

  const written: string[] = [];
  shards.forEach((urls, i) => {
    const file = `sitemap-${i}.xml`;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
    if (writer.writeIfChanged(file, xml)) written.push(file);
  });
  // A shrinking catalog leaves shard files beyond the new count; delete them
  // so stale URLs are not left crawlable on disk.
  for (let i = shards.length; ; i++) {
    const file = `sitemap-${i}.xml`;
    const before = writer.deletedFiles.length;
    writer.deletePage(file);
    if (writer.deletedFiles.length === before) break;
  }

  const index = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${shards
    .map((_, i) => `  <sitemap><loc>${base}/sitemap-${i}.xml</loc></sitemap>`)
    .join("\n")}\n</sitemapindex>\n`;
  if (writer.writeIfChanged("sitemap.xml", index)) written.push("sitemap.xml");
  return written;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
