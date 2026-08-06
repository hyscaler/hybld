import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Fetcher } from "./http.js";

export interface ImageLocalizerOptions {
  origins: string[];
  dir: string; // subdirectory under outDir, e.g. "media"
  outDir: string;
  fetcher?: Fetcher;
}

/**
 * Image localization: downloads CMS-hosted images referenced in rendered HTML
 * into the output directory and rewrites their URLs, so the static site does
 * not depend on the CMS at serve time. Handles src attributes; downloads each
 * unique URL once per process. No resizing/optimization (that would require a
 * native imaging dependency; see roadmap).
 */
export class ImageLocalizer {
  private done = new Map<string, string>(); // remote url -> local path
  private failed = new Set<string>();
  /** Files actually written since the last drain (relative to outDir). */
  private newFiles: string[] = [];

  constructor(private opts: ImageLocalizerOptions) {}

  drainNewFiles(): string[] {
    const files = this.newFiles;
    this.newFiles = [];
    return files;
  }

  /**
   * Apply already-discovered URL mappings to arbitrary text (e.g. Next RSC
   * payloads, where URLs appear inside escaped JSON and the src/href regex
   * cannot find them). Call after localizeHtml has processed the page's HTML.
   */
  applyKnownMappings(content: string): string {
    for (const [remote, local] of this.done) {
      content = content.split(remote).join(local);
      const escaped = remote.replace(/&/g, "&amp;");
      if (escaped !== remote) content = content.split(escaped).join(local);
    }
    return content;
  }

  private matches(url: string): boolean {
    return this.opts.origins.some((o) => url.startsWith(o));
  }

  private localPathFor(url: string): string {
    const clean = url.split("?")[0];
    const ext = extname(clean) || ".img";
    const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
    return `/${this.opts.dir}/${hash}${ext}`;
  }

  async localizeHtml(html: string): Promise<{ html: string; downloaded: string[] }> {
    // raw attribute text (possibly entity-escaped) -> decoded URL to fetch.
    const candidates = new Map<string, string>();
    const consider = (raw: string) => {
      // SSR escapes & as &amp; inside attributes; fetch the decoded URL but
      // rewrite the raw text as it appears in the HTML.
      const url = raw.replace(/&amp;/g, "&").replace(/&#38;/g, "&");
      if (this.matches(url) && /\.(png|jpe?g|gif|webp|avif|svg|ico)(\?|$)/i.test(url)) candidates.set(raw, url);
    };
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) consider(m[1]);
    for (const m of html.matchAll(/srcset="([^"]+)"/g)) {
      for (const candidate of m[1].split(",")) {
        const raw = candidate.trim().split(/\s+/)[0];
        if (raw) consider(raw);
      }
    }
    const downloaded: string[] = [];
    for (const [raw, url] of candidates) {
      const local = await this.download(url);
      if (local) {
        html = html.split(raw).join(local);
        if (raw !== url) html = html.split(url).join(local);
        downloaded.push(local);
      }
    }
    return { html, downloaded };
  }

  private async download(url: string): Promise<string | null> {
    if (this.done.has(url)) return this.done.get(url)!;
    if (this.failed.has(url)) return null;
    const local = this.localPathFor(url);
    const target = join(this.opts.outDir, local.replace(/^\//, ""));
    if (existsSync(target)) {
      this.done.set(url, local);
      return local;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = this.opts.fetcher ? await this.opts.fetcher(url) : await fetch(url);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        mkdirSync(join(this.opts.outDir, this.opts.dir), { recursive: true });
        writeFileSync(target, buf);
        this.done.set(url, local);
        this.newFiles.push(local.replace(/^\//, ""));
        return local;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
      }
    }
    this.failed.add(url); // leave the original URL in place
    return null;
  }
}
