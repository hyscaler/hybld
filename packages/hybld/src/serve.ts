import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { Builder } from "./builder.js";
import type { ArticleRef, CollectionPageConfig } from "./types.js";

export interface ServeOptions {
  port: number;
  /** Bind address. Default 127.0.0.1; binding wider requires a secret (or insecure: true). */
  host?: string;
  /** Shared secret required (x-hybld-secret header) on POST endpoints. */
  secret?: string;
  /** Explicitly allow a non-loopback bind without a secret (NOT recommended). */
  insecure?: boolean;
  /** Also serve the static output directory. */
  serveStatic?: boolean;
  /** On a static-file miss, resolve the route via pages.article.match and build it on demand. */
  regenOnMiss?: boolean;
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

/** Max accepted request body (webhook payloads are small; anything bigger is abuse). */
const MAX_BODY_BYTES = 1_048_576;
/** How long a failed/unproductive regen-on-miss blocks retries for that route. */
const REGEN_NEGATIVE_TTL_MS = 60_000;
/** Max distinct routes allowed to regenerate concurrently. */
const REGEN_MAX_INFLIGHT = 8;
/** Max routes remembered in the regen negative cache (bounds memory under junk-URL floods). */
const REGEN_NEGATIVE_MAX = 10_000;

/**
 * TTL cache with a hard size bound. Entries expire on read after ttlMs; when
 * a set would exceed maxSize, the oldest entries are evicted. Without the
 * bound, a crawler spraying distinct pattern-matching URLs at a weeks-old
 * `serve --regen` process would grow the negative cache without limit.
 */
export class BoundedTtlCache {
  private entries = new Map<string, number>();

  constructor(
    private ttlMs: number,
    private maxSize: number
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    const at = this.entries.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key: string): void {
    // Delete-then-set keeps Map insertion order equal to recency order, so
    // eviction below always removes the stalest entries first.
    this.entries.delete(key);
    this.entries.set(key, Date.now());
    if (this.entries.size <= this.maxSize) return;
    const now = Date.now();
    for (const [k, at] of this.entries) {
      if (this.entries.size <= this.maxSize) break;
      if (now - at > this.ttlMs) this.entries.delete(k);
    }
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}

function secretMatches(provided: unknown, secret: string): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Webhook/rebuild server over the warm builder:
 *   POST /rebuild            {routes|slugs|ids|since|stale|all} -> build summary
 *   POST /webhook/wordpress  WordPress publish/update payload -> targeted build
 *   GET  /healthz
 * With serveStatic: serves the output dir; with regenOnMiss: unknown article
 * routes are resolved via pages.article.match and built on demand (ISR-style).
 */
export function startServer(builder: Builder, opts: ServeOptions): Server {
  const log = opts.log ?? (() => {});
  const host = opts.host ?? "127.0.0.1";
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
  if (!loopback && !opts.secret && !opts.insecure) {
    throw new Error(
      `hybld serve: binding to ${host} without --secret would let anyone on the network trigger builds. ` +
        `Set --secret <value>, bind to 127.0.0.1 (default), or pass --insecure if you accept the risk.`
    );
  }
  if (!opts.secret) {
    log("warning: no --secret set; POST endpoints accept requests from anything that can reach this port");
  }
  const outDir = builder.config.outDir;
  const regenInFlight = new Set<string>();
  // Routes whose regen produced nothing recently (size-bounded: junk-URL
  // floods must not grow a long-lived process without limit).
  const regenNegative = new BoundedTtlCache(REGEN_NEGATIVE_TTL_MS, REGEN_NEGATIVE_MAX);
  const matchRoute = (route: string): ArticleRef | null => {
    for (const page of Object.values(builder.config.pages)) {
      const m = (page as CollectionPageConfig | undefined)?.match?.(route);
      if (m) return m;
    }
    return null;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${opts.port}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "POST") {
        if (opts.secret && !secretMatches(req.headers["x-hybld-secret"], opts.secret)) {
          return sendJson(res, 401, { error: "invalid or missing x-hybld-secret" });
        }
        const body = await readBody(req);
        if (body === TOO_LARGE) return sendJson(res, 413, { error: "request body too large" });

        if (url.pathname === "/rebuild") {
          const scope: any = {};
          for (const key of ["routes", "slugs", "ids", "since", "stale", "all", "chunkSize", "force"]) {
            if (body[key] !== undefined) scope[key] = body[key];
          }
          if (Object.keys(scope).length === 0) {
            return sendJson(res, 400, { error: "no build scope given (routes, slugs, ids, since, stale, all)" });
          }
          log(`rebuild request: ${JSON.stringify(scope)}`);
          const summary = await builder.build(scope);
          return sendJson(res, summary.failed.length ? 207 : 200, summary);
        }

        if (url.pathname === "/webhook/wordpress") {
          const id = body.post_id ?? body.post?.ID ?? body.post?.id ?? body.id;
          if (id === undefined) return sendJson(res, 400, { error: "no post id found in webhook payload" });
          log(`wordpress webhook: post ${id}`);
          const summary = await builder.build({ ids: [id] });
          return sendJson(res, summary.failed.length ? 207 : 200, summary);
        }

        return sendJson(res, 404, { error: "unknown endpoint" });
      }

      if (req.method === "GET" && opts.serveStatic) {
        return await serveStatic(res, url.pathname);
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
  });

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const file = resolveFile(pathname);
    if (file) return sendFile(res, file);

    // On-demand regeneration (ISR-style) for unknown article routes. Guarded
    // against abuse: any URL matching a collection pattern would otherwise
    // trigger a real build (a full framework build on delegated backends), so
    // unproductive routes are negative-cached and concurrency is capped.
    if (opts.regenOnMiss) {
      const route = pathname.endsWith("/") ? pathname : `${pathname}/`;
      const ref = !regenNegative.has(route) ? matchRoute(route) : null;
      if (ref && regenInFlight.size >= REGEN_MAX_INFLIGHT && !regenInFlight.has(route)) {
        res.writeHead(503, { "retry-after": "30", "content-type": "application/json" });
        res.end(JSON.stringify({ status: "busy", route, retryAfterSeconds: 30 }));
        return;
      }
      if (ref) {
        if (builder.backendMode === "delegated") {
          // A delegated regen costs a full framework build; never block the
          // HTTP request on it. Kick it off once and tell the client to retry.
          if (!regenInFlight.has(route)) {
            regenInFlight.add(route);
            log(`regen on miss (async, delegated backend): ${route}`);
            builder
              .build({ routes: [route] })
              .then(
                (summary) => {
                  if (summary.built.length === 0) regenNegative.add(route);
                },
                (err) => {
                  regenNegative.add(route);
                  log(`regen failed for ${route}: ${err?.message ?? err}`);
                }
              )
              .then(() => regenInFlight.delete(route));
          }
          res.writeHead(503, { "retry-after": "15", "content-type": "application/json" });
          res.end(JSON.stringify({ status: "regenerating", route, retryAfterSeconds: 15 }));
          return;
        }
        log(`regen on miss: ${route}`);
        regenInFlight.add(route);
        try {
          await builder.build({ routes: [route] });
        } finally {
          regenInFlight.delete(route);
        }
        const rebuilt = resolveFile(pathname);
        if (rebuilt) return sendFile(res, rebuilt);
        regenNegative.add(route);
      }
    }

    const notFound = join(outDir, "404.html");
    if (existsSync(notFound)) {
      res.writeHead(404, { "content-type": MIME[".html"] });
      res.end(readFileSync(notFound));
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  }

  function resolveFile(pathname: string): string | null {
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const candidates = safe.endsWith("/")
      ? [join(outDir, safe, "index.html")]
      : [join(outDir, safe), join(outDir, safe, "index.html")];
    for (const c of candidates) {
      if (c.startsWith(outDir) && existsSync(c) && statSync(c).isFile()) return c;
    }
    return null;
  }

  server.listen(opts.port, host, () => {
    log(`hybld serve listening on http://${host}:${opts.port}`);
  });
  return server;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, file: string): void {
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

/** Sentinel returned by readBody for oversized payloads. */
const TOO_LARGE = Symbol("body-too-large");

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let overflow = false;
    req.on("data", (c) => {
      if (overflow) return;
      data += c;
      if (data.length > MAX_BODY_BYTES) {
        overflow = true;
        data = "";
      }
    });
    req.on("end", () => {
      if (overflow) return resolve(TOO_LARGE);
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}
