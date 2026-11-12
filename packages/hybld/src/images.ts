import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Fetcher } from "./http.js";

export interface ImageLocalizerOptions {
  origins: string[];
  dir: string; // subdirectory under outDir, e.g. "media"
  outDir: string;
  fetcher?: Fetcher;
  /** Resize and re-encode raster images with sharp (optional dependency). */
  optimize?: { maxWidth: number; format: "webp" | "avif" | "original"; quality: number };
}

/** Formats sharp re-encodes. Everything else (SVG, GIF, ICO) is copied as is. */
const RASTER = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);

/**
 * Image localization: downloads CMS-hosted images referenced in rendered HTML
 * into the output directory and rewrites their URLs, so the static site does
 * not depend on the CMS at serve time. Handles src attributes; downloads each
 * unique URL once per process. With `optimize`, raster images are capped to a
 * maximum width and re-encoded through sharp before they are written; sharp is
 * an optional dependency, loaded only when optimization is switched on.
 */
export class ImageLocalizer {
  private done = new Map<string, string>(); // remote url -> local path
  private failed = new Set<string>();
  /** Files actually written since the last drain (relative to outDir). */
  private newFiles: string[] = [];

  private sharp: any = null;

  constructor(private opts: ImageLocalizerOptions) {}

  /** Load sharp up front so a missing install fails the build with a clear message, not silently per image. */
  async init(): Promise<void> {
    if (!this.opts.optimize || this.sharp) return;
    try {
      const name = "sharp";
      const mod: any = await import(name);
      this.sharp = mod.default ?? mod;
    } catch {
      throw new Error(
        "images.optimize needs the `sharp` package, which is not installed. " +
          "Add it to the project (npm install -D sharp) or remove images.optimize from the config."
      );
    }
  }

  private optimizable(ext: string): boolean {
    return Boolean(this.opts.optimize) && RASTER.has(ext.toLowerCase());
  }

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
    const o = this.opts.optimize;
    if (o && this.optimizable(ext)) {
      // The settings are part of the name: changing them produces new files
      // instead of silently reusing images encoded with the old settings.
      const hash = createHash("sha1").update(url).update(`${o.maxWidth}|${o.format}|${o.quality}`).digest("hex").slice(0, 16);
      return `/${this.opts.dir}/${hash}${o.format === "original" ? ext : `.${o.format}`}`;
    }
    const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
    return `/${this.opts.dir}/${hash}${ext}`;
  }

  private async encode(buf: Buffer, ext: string): Promise<Buffer> {
    const o = this.opts.optimize!;
    let img = this.sharp(buf).rotate().resize({ width: o.maxWidth, withoutEnlargement: true });
    const format = o.format === "original" ? ext.toLowerCase().replace(".", "").replace("jpg", "jpeg") : o.format;
    img = img.toFormat(format, { quality: o.quality });
    return img.toBuffer();
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
        let buf: Buffer = Buffer.from(await res.arrayBuffer());
        const ext = extname(url.split("?")[0]);
        if (this.optimizable(ext)) buf = await this.encode(buf, ext);
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
