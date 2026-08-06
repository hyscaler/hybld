import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Map a route to its output file path relative to outDir (FR-9). Routes are
 * built from CMS-controlled slugs, so "." / ".." segments are rejected: they
 * would let a malicious slug write outside outDir.
 */
export function routeToOutputPath(route: string): string {
  if (route === "/") return "index.html";
  const trimmed = route.replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = trimmed.split("/").filter((s) => s !== "");
  for (const seg of segments) {
    if (seg === "." || seg === ".." || seg.includes("\\")) {
      throw new Error(`Unsafe route "${route}": segments must not be ".", "..", or contain "\\".`);
    }
  }
  const path = segments.join("/");
  if (path.endsWith(".html")) return path;
  return `${path}/index.html`;
}

export class OutputWriter {
  created: string[] = [];
  updated: string[] = [];
  deletedFiles: string[] = [];

  constructor(private outDir: string) {}

  /** Resolve a relative path and refuse anything that escapes outDir. */
  private resolveSafe(relPath: string): string {
    const root = resolve(this.outDir);
    const target = resolve(root, relPath);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`Refusing to touch a path outside outDir: ${relPath}`);
    }
    return target;
  }

  /** Atomic, additive page write: temp file + rename (FR-9). */
  writePage(relPath: string, html: string): void {
    const target = this.resolveSafe(relPath);
    mkdirSync(dirname(target), { recursive: true });
    const existed = existsSync(target);
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, html);
    renameSync(tmp, target);
    (existed ? this.updated : this.created).push(relPath);
  }

  /** Write only when content differs; returns whether a write happened. */
  writeIfChanged(relPath: string, content: string): boolean {
    const target = this.resolveSafe(relPath);
    if (existsSync(target)) {
      const current = readFileSafe(target);
      if (current === content) return false;
    }
    this.writePage(relPath, content);
    return true;
  }

  deletePage(relPath: string): void {
    const target = this.resolveSafe(relPath);
    if (!existsSync(target)) return;
    rmSync(target);
    this.deletedFiles.push(relPath);
    // Prune now-empty parent directories up to outDir.
    let dir = dirname(target);
    while (dir.startsWith(this.outDir) && relative(this.outDir, dir) !== "") {
      if (readdirSync(dir).length > 0) break;
      rmSync(dir, { recursive: true });
      dir = dirname(dir);
    }
  }
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
