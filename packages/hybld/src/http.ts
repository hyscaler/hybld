import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FetcherOptions {
  concurrency?: number;
  requestsPerSecond?: number;
  retries?: number;
  headers?: Record<string, string>;
  /** Per-request timeout in ms (a hung CMS connection must not stall the build). Default 30000. */
  timeoutMs?: number;
  /** Deduplicate identical GETs within a run (cleared per build). Default true. */
  memoize?: boolean;
  /** URLs for which the disk cache must be bypassed (freshness-critical queries). */
  cacheBypass?: (url: string) => boolean;
}

export interface DiskCacheOptions {
  dir: string;
  ttlMs: number;
}

export interface Fetcher {
  (url: string, init?: RequestInit): Promise<Response>;
  requestCount(): number;
  clearMemo(): void;
  /** Enable the cross-run disk cache (FR-11). Trades freshness (within ttl) for CMS load. */
  enableDiskCache(opts: DiskCacheOptions): void;
}

interface MemoEntry {
  status: number;
  headers: Array<[string, string]>;
  text: string;
}

/**
 * Shared rate-limit layer (FR-11): bounded concurrency, optional req/s
 * throttle, retry with exponential backoff + jitter on 429/5xx honoring
 * Retry-After, and per-run GET memoization so dependent-page loaders do not
 * re-fetch data the same build already saw.
 */
export function createFetcher(opts: FetcherOptions = {}): Fetcher {
  const concurrency = opts.concurrency ?? 4;
  const retries = opts.retries ?? 4;
  const memoize = opts.memoize ?? true;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const minGapMs = opts.requestsPerSecond ? 1000 / opts.requestsPerSecond : 0;
  // Base headers participate in cache identity: two fetchers memoize
  // separately anyway, but a disk cache shared across configs must not serve
  // one credential's response to another.
  const headersKey = createHash("sha1").update(JSON.stringify(opts.headers ?? {})).digest("hex").slice(0, 8);

  let active = 0;
  let lastStart = 0;
  let count = 0;
  let diskCache: DiskCacheOptions | null = null;
  const queue: Array<() => void> = [];
  const memo = new Map<string, Promise<MemoEntry>>();

  const diskPath = (url: string) =>
    join(diskCache!.dir, `${createHash("sha1").update(headersKey).update(url).digest("hex")}.json`);

  const diskRead = (url: string): MemoEntry | null => {
    if (!diskCache || opts.cacheBypass?.(url)) return null;
    try {
      const p = diskPath(url);
      if (!existsSync(p)) return null;
      const entry = JSON.parse(readFileSync(p, "utf8"));
      if (Date.now() - entry.storedAt > diskCache.ttlMs) return null;
      return entry;
    } catch {
      return null;
    }
  };

  const diskWrite = (url: string, entry: MemoEntry): void => {
    if (!diskCache || opts.cacheBypass?.(url) || entry.status >= 400) return;
    try {
      mkdirSync(diskCache.dir, { recursive: true });
      writeFileSync(diskPath(url), JSON.stringify({ ...entry, storedAt: Date.now() }));
    } catch {
      /* cache write failures are non-fatal */
    }
  };

  const acquire = () =>
    new Promise<void>((resolve) => {
      const tryRun = () => {
        if (active < concurrency) {
          active++;
          resolve();
        } else {
          queue.push(tryRun);
        }
      };
      tryRun();
    });

  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const rawFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        if (minGapMs > 0) {
          const wait = lastStart + minGapMs - Date.now();
          if (wait > 0) await sleep(wait);
          lastStart = Date.now();
        }
        count++;
        let res: Response | null = null;
        let netError: unknown = null;
        try {
          res = await fetch(url, {
            ...init,
            headers: { ...opts.headers, ...(init?.headers as Record<string, string>) },
            signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
          });
        } catch (err: any) {
          netError = err?.name === "TimeoutError" ? new Error(`request to ${url} timed out after ${timeoutMs}ms`) : err;
        }
        if (res && res.status < 500 && res.status !== 429) return res;
        if (attempt >= retries) {
          if (res) return res;
          throw netError;
        }
        const backoff = parseRetryAfter(res?.headers.get("retry-after")) ?? Math.min(30_000, 250 * 2 ** attempt) + Math.random() * 250;
        await sleep(backoff);
      }
    } finally {
      release();
    }
  };

  const fetcher = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (!memoize || method !== "GET") return rawFetch(url, init);

    let entry = memo.get(url);
    if (!entry) {
      const fromDisk = diskRead(url);
      entry = fromDisk
        ? Promise.resolve(fromDisk)
        : rawFetch(url, init).then(async (res) => {
            const e: MemoEntry = {
              status: res.status,
              headers: [...res.headers.entries()],
              text: await res.text(),
            };
            diskWrite(url, e);
            return e;
          });
      memo.set(url, entry);
      entry.catch(() => memo.delete(url)); // do not cache network failures
    }
    const cached = await entry;
    if (cached.status >= 400) memo.delete(url); // do not pin error responses
    return new Response(cached.text, { status: cached.status, headers: cached.headers });
  }) as Fetcher;

  fetcher.requestCount = () => count;
  fetcher.clearMemo = () => memo.clear();
  fetcher.enableDiskCache = (o) => {
    diskCache = o;
  };
  return fetcher;
}

/** Retry-After: delta-seconds ("120") or an HTTP-date; returns ms, or null when absent/unparseable. */
function parseRetryAfter(value: string | null | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}
