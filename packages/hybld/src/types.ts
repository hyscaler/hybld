export interface ListOpts {
  page: number;
  perPage: number;
  /** Adapter-specific filters (e.g. category) are passed through. */
  [key: string]: unknown;
}

export interface ListResult<T> {
  items: T[];
  hasMore: boolean;
}

export interface ArticleRef {
  id?: string | number;
  slug?: string;
}

export interface TermRef {
  id: string | number;
  slug: string;
  name: string;
  /** Number of articles in this term, when the CMS reports it; used to derive pageCount for paginated archives. */
  count?: number;
}

export interface CmsAdapter<TArticle = any> {
  name: string;
  count(): Promise<number>;
  listArticles(opts: ListOpts): Promise<ListResult<TArticle>>;
  getArticle(ref: ArticleRef): Promise<TArticle | null>;
  /** Optional: required for `--since` incremental builds. */
  listModifiedSince?(date: Date, opts: ListOpts): Promise<ListResult<TArticle>>;
  /** Optional: CMSes that can report deletions/unpublishes. */
  listDeletedSince?(date: Date): Promise<ArticleRef[]>;
  /** Optional: taxonomy terms for aggregate pages. */
  listTerms?(taxonomy: string): Promise<TermRef[]>;
  /** Optional: fetch an article regardless of publish status, for draft previews. */
  getPreview?(ref: ArticleRef): Promise<TArticle | null>;
}

/** Helper handed to aggregate data loaders; wraps the adapter. */
export interface CmsHelper {
  list(opts?: Partial<ListOpts>): Promise<any[]>;
  listTerms(taxonomy: string): Promise<TermRef[]>;
  getArticle(ref: ArticleRef): Promise<any | null>;
  count(): Promise<number>;
  raw: CmsAdapter;
}

export interface LoaderCtx {
  cms: CmsHelper;
}

export type DependentRef =
  | string
  | { type: string; id?: string | number; depth?: number };

/** One language version of a page. */
export interface Alternate {
  /** BCP 47 language tag ("en", "hi", "en-IN") or "x-default". */
  lang: string;
  /** Site-relative route of that version. */
  route: string;
}

export interface CollectionPageConfig<TArticle = any> {
  /** Marks this page type as adapter-backed (one page per CMS item). The page type named "article" is a collection by default. */
  collection?: boolean;
  /** Adapter for this collection. Defaults to the top-level adapter (use per-collection adapters for authors/products/etc.). */
  adapter?: CmsAdapter;
  route: (article: TArticle) => string;
  data: (article: TArticle) => any | Promise<any>;
  dependents?: (article: TArticle) => DependentRef[];
  /**
   * Language versions of this page, itself included, for multi-locale sites:
   * `[{ lang: "en", route: "/en/a/" }, { lang: "hi", route: "/hi/a/" }]`.
   * Use lang "x-default" for the fallback version. hybld writes them to the
   * sitemap as hreflang alternates and hands them to the page renderer.
   */
  alternates?: (article: TArticle) => Alternate[];
  /** Inverse of route(): resolve a route back to an article ref. Enables serve-mode regeneration on miss. */
  match?: (route: string) => ArticleRef | null;
  /** Extract a stable id from the raw article. Default: article.id */
  id?: (article: TArticle) => string | number;
  /** Extract the CMS modified date. Default: article.modified ?? article.modifiedAt */
  modifiedAt?: (article: TArticle) => string | undefined;
  /** Extract the slug. Default: article.slug */
  slug?: (article: TArticle) => string | undefined;
}

export interface AggregatePageConfig {
  /** Enumerate instances (e.g. categories). Omit for singletons like home/404. */
  enumerate?: (ctx: LoaderCtx) => Promise<any[]> | any[];
  paginate?: { perPage: number };
  /** Number of pages for a paginated instance. Default 1. */
  pageCount?: (item: any, ctx: LoaderCtx) => Promise<number> | number;
  /** Singleton: route(). Enumerated: route(item, page). */
  route: (item?: any, page?: number) => string;
  /** Singleton: data(ctx). Enumerated: data(item, page, ctx). */
  data: (...args: any[]) => any | Promise<any>;
}

/** A render backend: how pages become HTML. */
export interface RenderBackend {
  name: string;
  /** owned: hybld renders pages itself. delegated: the framework's own build renders a scoped batch. */
  mode: "owned" | "delegated";
  /** Prepare artifacts and compute the asset graph hash (owned: vite builds with reuse; delegated: source fingerprint only). */
  prepare(opts: { clean: boolean }): Promise<void>;
  readonly assetGraphHash: string;
  /** Asset files (relative to outDir) known to belong to the current graph. Delegated backends report them after renderBatch. */
  readonly assetFiles: string[];
  /** Directories under outDir that hold hashed assets (for gc and merge). */
  readonly assetDirs: string[];
  renderBatch(jobs: RenderJob[], opts?: { noindex?: boolean }): Promise<RenderedPage[]>;
  /** Framework sidecar files that belong to a page (e.g. Next RSC .txt), for deletions/moves. */
  pageSidecars(outputPath: string): string[];
  /**
   * Post-merge housekeeping in the cumulative outDir (e.g. Next fans out
   * Pages Router _next/data JSON across buildId dirs). `removals` are
   * executed with the run's deferred deletions; created/updated feed the
   * changed-files report.
   */
  finalizeMerge?(ctx: { deletedPageOutputs: string[] }): { created: string[]; updated: string[]; removals: string[] };
  destroy(): void;
}

export interface RenderJob {
  route: string;
  pageType: string;
  data: any;
  /** Present for collection pages: the raw article, so delegated scope files can pass params. */
  article?: any;
  slug?: string | null;
  id?: string | null;
  /** Aggregate pagination info for delegated scope files. */
  item?: any;
  page?: number;
  /** Language versions of the page (collection pages that define `alternates`). */
  alternates?: Alternate[];
}

export type RenderedPage =
  | { route: string; kind: "html"; html: string }
  | { route: string; kind: "files"; outputPath: string; files: Array<{ absPath: string; relPath: string }> }
  | { route: string; kind: "extra"; outputPath: string; files: Array<{ absPath: string; relPath: string }> }
  | { route: string; kind: "failed"; error: string };

/** Factory stored in config; the builder instantiates the backend with the resolved config. */
export interface RendererFactory {
  name: string;
  mode: "owned" | "delegated";
  create(config: ResolvedConfig, opts: { externalClientBuild?: boolean }): RenderBackend;
}

export interface HybldConfig {
  adapter: CmsAdapter;
  /** How pages are rendered. Default: the built-in react-vite backend configured via `render`. */
  renderer?: RendererFactory;
  /** Project root containing index.html and vite config. Default: cwd. */
  root?: string;
  outDir?: string;
  basePath?: string;
  manifest?: string;
  /**
   * Snapshot the manifest to `<manifest>.bak` after builds that changed
   * something, at most once per `everyMinutes` (default 60). A missing or
   * unreadable manifest is restored from the snapshot automatically. `false`
   * switches backups off.
   */
  manifestBackup?: false | { everyMinutes?: number };
  render?: {
    entry?: string;
    template?: string;
    workers?: number;
    /** Per-page render timeout in milliseconds (a hung render fails the page instead of stalling the build). Default 60000. */
    timeout?: number;
    /**
     * Delegated backends (Next.js, Astro) only: split a large scope into
     * framework builds of at most this many pages, checkpointing the manifest
     * between them. Default: the whole scope in one framework build.
     */
    batchSize?: number;
  };
  cms?: {
    concurrency?: number;
    perPage?: number;
    requestsPerSecond?: number;
    /** Cross-run disk cache for CMS responses. true = 300s TTL. Modified-since and trash queries always bypass it. */
    cache?: boolean | { ttlSeconds?: number };
  };
  /** Emit a data.json alongside every page's HTML (enables client-side navigation without CMS calls). */
  emitData?: boolean;
  /** RSS feed generated incrementally from the manifest, like the sitemap. */
  feed?: {
    enabled: boolean;
    baseUrl?: string;
    title?: string;
    description?: string;
    limit?: number;
    /** Map an article to its feed entry. Default reads title/excerpt/date from WordPress-shaped articles. */
    item?: (article: any) => { title: string; description?: string; date?: string; author?: string };
  };
  /** Download CMS-hosted images referenced in rendered HTML into the output and rewrite their URLs. */
  images?: {
    /** Origins to localize, e.g. ["https://cms.example.com"]. */
    origins: string[];
    /** Output subdirectory for downloaded media. Default "media". */
    dir?: string;
    /**
     * Resize and re-encode downloaded raster images (PNG, JPEG, WebP, AVIF).
     * Needs the optional `sharp` package installed in the project. SVG, GIF
     * and ICO files are copied untouched.
     */
    optimize?: {
      /** Cap the width in pixels; smaller images are never enlarged. Default 1600. */
      maxWidth?: number;
      /** Output format. "original" keeps each image's own format. Default "webp". */
      format?: "webp" | "avif" | "original";
      /** Encoder quality, 1 to 100. Default 80. */
      quality?: number;
    };
  };
  /** Draft preview builds (hybld preview). */
  preview?: {
    /** Path prefix for preview pages. Default "/_preview". */
    pathPrefix?: string;
  };
  pages: {
    /** The collection page type keyed "article" (one page per CMS item). */
    article?: CollectionPageConfig;
    [pageType: string]: CollectionPageConfig | AggregatePageConfig | undefined;
  };
  sitemap?: { enabled: boolean; baseUrl?: string };
  redirects?: { file?: string };
}

export interface ResolvedConfig {
  adapter: CmsAdapter;
  /** Resolved lazily to the react-vite default in the Builder, keeping the config-loading graph free of vite imports. */
  renderer?: RendererFactory;
  root: string;
  configDir: string;
  /** Absolute path of the loaded config file (null when constructed programmatically). */
  configFile: string | null;
  outDir: string;
  basePath: string;
  manifest: string;
  manifestBackup: { everyMinutes: number } | null;
  render: { entry: string; template: string; workers: number; timeout: number; batchSize?: number };
  cms: { concurrency: number; perPage: number; requestsPerSecond?: number; cache: false | { ttlSeconds: number } };
  pages: HybldConfig["pages"];
  sitemap: { enabled: boolean; baseUrl?: string };
  feed: {
    enabled: boolean;
    baseUrl?: string;
    title: string;
    description: string;
    limit: number;
    item?: (article: any) => { title: string; description?: string; date?: string; author?: string };
  };
  redirects: { file: string };
  emitData: boolean;
  images: {
    origins: string[];
    dir: string;
    optimize: { maxWidth: number; format: "webp" | "avif" | "original"; quality: number } | null;
  } | null;
  preview: { pathPrefix: string };
}

export interface BuildOptions {
  all?: boolean;
  limit?: number;
  chunk?: { index: number; total: number };
  chunkSize?: number;
  routes?: string[];
  slugs?: string[];
  ids?: Array<string | number>;
  since?: string; // "last-build" or ISO date
  stale?: boolean;
  /** Prune CMS-side deletions: full ID sweep, then delete every page whose article is gone. */
  reconcile?: boolean;
  clean?: boolean;
  dryRun?: boolean;
  force?: boolean;
  noDependents?: boolean;
  failFast?: boolean;
  concurrency?: number;
  /** Delegated backends: pages per framework build for this run (overrides render.batchSize). */
  batchSize?: number;
  /**
   * Manifest recovery: record pages whose output file already exists as
   * built, without rendering them. Pages with no output file build normally.
   */
  adopt?: boolean;
}

export interface PageFailure {
  route: string;
  error: string;
}

export interface BuildSummary {
  mode: string;
  built: string[];
  skipped: string[];
  failed: PageFailure[];
  deleted: string[];
  moved: Array<{ from: string; to: string }>;
  dependentsRebuilt: string[];
  cmsRequests: number;
  durationMs: number;
  assetGraphHash: string;
  reportPath?: string;
  dryRun?: boolean;
  plannedRoutes?: string[];
  /** Pages recorded from existing output files during a manifest adopt run. */
  adopted?: number;
}

export interface ManifestRow {
  route: string;
  pageType: string;
  articleId: string | null;
  slug: string | null;
  sourceRef: string | null;
  /** JSON-serialized DependentRef[] captured at build time, so deletions can rebuild the right pages. */
  dependentsRef: string | null;
  /** JSON-serialized feed entry ({title, description, date}) captured at build time when the feed is enabled. */
  feedRef: string | null;
  /** JSON-serialized Alternate[] (language versions), for sitemap hreflang links. */
  alternatesRef?: string | null;
  contentHash: string | null;
  cmsModifiedAt: string | null;
  builtAt: string;
  assetGraphHash: string;
  outputPath: string;
}

export interface StatusReport {
  totalPages: number;
  byPageType: Record<string, number>;
  codeStale: number;
  lastBuildAt: string | null;
  lastFullBuildAt: string | null;
  currentAssetGraphHash: string | null;
}
