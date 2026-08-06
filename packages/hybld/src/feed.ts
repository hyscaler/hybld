import type { Manifest } from "./manifest.js";
import type { OutputWriter } from "./output.js";
import type { ResolvedConfig } from "./types.js";

/**
 * RSS 2.0 feed maintained incrementally from the manifest, like the sitemap.
 * Feed entries come from feed_ref captured at article build time, so no CMS
 * requests are needed to regenerate it.
 */
export function writeFeed(manifest: Manifest, writer: OutputWriter, feed: ResolvedConfig["feed"]): boolean {
  const base = (feed.baseUrl ?? "").replace(/\/+$/, "");
  const rows = manifest.feedRows(feed.limit);

  const items = rows
    .map((r) => {
      let entry: { title?: string; description?: string; date?: string; author?: string } = {};
      try {
        entry = JSON.parse(r.feedRef ?? "{}");
      } catch {
        /* skip malformed */
      }
      // First parseable of entry date / cms modified / built-at; a malformed
      // CMS date must not emit a literal "Invalid Date" (invalid RSS).
      const date = [entry.date, r.cmsModifiedAt, r.builtAt]
        .map((d) => (d ? new Date(d) : null))
        .find((d) => d && !Number.isNaN(d.getTime()));
      return [
        "    <item>",
        `      <title>${escapeXml(entry.title ?? r.slug ?? r.route)}</title>`,
        `      <link>${base}${escapeXml(r.route)}</link>`,
        `      <guid isPermaLink="true">${base}${escapeXml(r.route)}</guid>`,
        entry.description ? `      <description><![CDATA[${cdataSafe(entry.description)}]]></description>` : "",
        entry.author ? `      <author>${escapeXml(entry.author)}</author>` : "",
        date ? `      <pubDate>${date.toUTCString()}</pubDate>` : "",
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(feed.title)}</title>
    <link>${base}/</link>
    <description>${escapeXml(feed.description)}</description>
${items}
  </channel>
</rss>
`;
  return writer.writeIfChanged("feed.xml", xml);
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cdataSafe(s: string): string {
  return s.replaceAll("]]>", "]]&gt;");
}
