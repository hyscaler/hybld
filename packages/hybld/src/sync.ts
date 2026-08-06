import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SyncOptions {
  outDir: string;
  /** Path to the changed-files report (last-build.json). */
  reportPath: string;
  targetDir: string;
  /** Also delete files the report lists as deleted. */
  deleteRemoved?: boolean;
  /** Emit a host redirect file generated from the redirects map. */
  redirects?: { format: "netlify" | "nginx"; map: Record<string, string> };
}

export interface SyncResult {
  copied: string[];
  deleted: string[];
  redirectsFile?: string;
}

/**
 * Deploy sync: applies exactly the changes from the last build's changed-files
 * report (FR-18) to a target directory. This is the local/NFS/rsync-staging
 * flavor; for S3/CDN use the report directly with your CLI of choice, e.g.
 * `aws s3 cp` each listed file, then invalidate the listed paths.
 */
export function syncOutput(opts: SyncOptions): SyncResult {
  if (!existsSync(opts.reportPath)) {
    throw new Error(`changed-files report not found: ${opts.reportPath} (run a build first)`);
  }
  const report = JSON.parse(readFileSync(opts.reportPath, "utf8"));
  const files: { created?: string[]; updated?: string[]; deleted?: string[] } = report.files ?? {};

  const copied: string[] = [];
  for (const rel of [...(files.created ?? []), ...(files.updated ?? [])]) {
    const from = join(opts.outDir, rel);
    if (!existsSync(from)) continue; // superseded by a later build
    const to = join(opts.targetDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(rel);
  }

  const deleted: string[] = [];
  if (opts.deleteRemoved) {
    for (const rel of files.deleted ?? []) {
      const target = join(opts.targetDir, rel);
      if (existsSync(target)) {
        rmSync(target);
        deleted.push(rel);
      }
    }
  }

  let redirectsFile: string | undefined;
  if (opts.redirects) {
    const entries = Object.entries(opts.redirects.map);
    if (opts.redirects.format === "netlify") {
      redirectsFile = join(opts.targetDir, "_redirects");
      mkdirSync(opts.targetDir, { recursive: true });
      writeFileSync(redirectsFile, entries.map(([from, to]) => `${from} ${to} 301`).join("\n") + "\n");
    } else {
      redirectsFile = join(opts.targetDir, "redirects.nginx.map");
      mkdirSync(opts.targetDir, { recursive: true });
      writeFileSync(redirectsFile, entries.map(([from, to]) => `${from} ${to};`).join("\n") + "\n");
    }
  }

  return { copied, deleted, redirectsFile };
}

/** Upload the manifest to a URL (works with S3 presigned PUT URLs, WebDAV, etc.). */
export async function pushManifest(manifestPath: string, url: string): Promise<void> {
  const body = readFileSync(manifestPath);
  const res = await fetch(url, { method: "PUT", body });
  if (!res.ok) throw new Error(`manifest push failed: ${res.status} ${res.statusText}`);
}

/** Download the manifest from a URL, replacing the local file. */
export async function pullManifest(manifestPath: string, url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`manifest pull failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, buf);
}
