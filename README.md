# hybld

Incremental and selective static builds for React + Vite, Next.js, Astro, SvelteKit and Nuxt projects backed by a headless CMS. Publish one article; rebuild one page and its listings, not the site.

**Documentation is a Starlight site in [`docs/`](./docs/)**: getting started, concepts, configuration and CLI references, per-framework guides, adapters, deployment, scaling to large catalogs, the programmatic API, backend authoring, and troubleshooting. Run it locally with `cd docs && npm install && npm run dev`, or read the markdown sources directly in `docs/src/content/docs/`. The original design documents are kept in `docs/history/` for context; they are not maintained.

Requires Node >= 22.5 (uses the built-in `node:sqlite`) and pnpm.

## Quickstart: run a starter against live data

The fastest way to see hybld work is a starter: three clone-and-run apps under [`examples/`](./examples/) that use the **published hybld packages** and pull real articles from a live public WordPress API (WP Tavern). No API keys, no local CMS.

```bash
pnpm install
cd examples/starter-react-vite     # or starter-next / starter-astro
pnpm run demo     # builds 12 real articles + home, and seeds the incremental cursor
pnpm run demo     # again: everything skips (nothing changed upstream)
pnpm run sweep    # --since last-build: only what the CMS edited since
pnpm run serve    # serve the output locally with regen-on-miss
```

Each starter's README explains the handful of files that make up the whole integration, and how to point `CMS_URL` at your own WordPress. See [`examples/README.md`](./examples/README.md) for the starters-vs-internal-demos split.

## Repo layout

| Path | What it is |
| ------ | ------------ |
| `packages/hybld` | Engine: CLI, programmatic API, render backends, SQLite manifest, adapter helpers, serve/sync tooling, Vite plugin. |
| `packages/next` | `@hybld/next`: Next.js backend (static export) plus `hybldParams`/`hybldData` helpers. |
| `packages/astro` | `@hybld/astro`: Astro backend plus `hybldPaths`/`hybldData` helpers. |
| `packages/sveltekit` | `@hybld/sveltekit`: SvelteKit backend (adapter-static) plus `hybldEntries`/`hybldData` helpers. |
| `packages/nuxt` | `@hybld/nuxt`: Nuxt backend, a Nuxt module and the `useHybldData` composable. |
| `packages/adapter-wordpress` | WordPress REST preset (previews, trash-driven deletions). |
| `packages/adapter-strapi` | Strapi v4/v5 preset. |
| `packages/adapter-contentful` | Contentful Delivery API preset. |
| `packages/adapter-sanity` | Sanity (GROQ) preset. |
| `examples/starter-react-vite` | **Start here.** React + Vite starter on the published packages against a live public WordPress API. |
| `examples/starter-next` | The same live-API starter on Next.js (App Router, static export). |
| `examples/starter-astro` | The same live-API starter on Astro. |
| `examples/demo-site` | Internal e2e fixture: React + Vite on workspace code, plus the bundled mock WordPress CMS. |
| `examples/next-demo` | Internal e2e fixture: Next.js App Router (`output: "export"`). |
| `examples/nextpages-demo` | Internal e2e fixture: Next.js Pages Router (the only `_next/data` fan-out e2e). |
| `examples/astro-demo` | Internal e2e fixture: Astro. |
| `examples/sveltekit-demo` | Internal e2e fixture: SvelteKit. |
| `examples/nuxt-demo` | Internal e2e fixture: Nuxt. |

## Two rendering strategies

**Owned (react-vite, the default)**: hybld runs the Vite client + SSR builds and renders every page itself. Warm single-page rebuilds in milliseconds; hybld controls head tags, hydration payloads, and previews.

**Delegated (next, astro, sveltekit, nuxt)**: hybld computes what changed, writes the scope to `.hybld/scope.ndjson`, runs the framework's own build (whose dynamic routes read the scope through the helper packages), then merges the emitted pages and hashed assets into its cumulative output dir. Each incremental run costs one framework build (Astro ~1s, Next ~5s in the demos), still nothing like a full rebuild at scale. The framework owns head tags and its 404 page; draft previews are react-vite only; every batch carries all singleton pages plus at least one page per dynamic route type (Next's export refuses an empty `generateStaticParams`).

Next backend requirements: `output: "export"`, `trailingSlash: true`, `serverExternalPackages: ["hybld", "@hybld/next", "jiti"]` in next.config, and a plain `.mjs` hybld config (it is also loaded inside Next build workers, where TypeScript configs cannot be imported). Sites served by a Next server should prefer Next's native ISR; this backend targets static hosting, where Next has no incremental story. See `examples/starter-next` and `examples/starter-astro` for complete working setups.

## Developing hybld itself

```bash
pnpm install
pnpm run build          # compile all packages (tests import from dist)
pnpm test               # full suite
```

The internal demos exercise the local workspace code against a deterministic mock CMS. Terminal 1: start the mock CMS (57 seeded articles, WordPress-shaped REST API):

```bash
cd examples/demo-site
pnpm run cms            # http://localhost:4399, data in mock-cms/articles.json
```

Terminal 2: run builds:

```bash
cd examples/demo-site

# Full build: 57 articles + home + 3 categories + 404 + sitemap
pnpm exec hybld build --all

# Run it again: everything is skipped (content hashes unchanged)
pnpm exec hybld build --all

# Preview any scope without building
pnpm exec hybld build --chunk 1/4 --dry-run
```

Publish a new article, then build only what changed:

```bash
# Add an object to mock-cms/articles.json with a fresh "modified" timestamp,
# or edit any article's content. Then:
pnpm exec hybld build --since last-build
# -> builds the changed article + home + its category page. Nothing else.
```

Other things to try:

```bash
pnpm exec hybld build --slugs demo-article-7        # targeted build
pnpm exec hybld build --ids 12                      # targeted by CMS id
pnpm exec hybld build --limit 10                    # smoke-test build
pnpm exec hybld build --stale --chunk-size 20       # converge pages after app-code changes
pnpm exec hybld preview --slugs upcoming-draft      # render a draft, noindexed, to /_preview/
pnpm exec hybld serve --port 4650 --static --regen  # webhook server + static host + regen-on-miss
pnpm exec hybld sync ../staging --delete --redirects netlify   # apply last build's changes to a dir
pnpm exec hybld assets gc --dry-run                 # find superseded hashed bundles
pnpm exec hybld manifest push --url <presigned-put-url>        # share the manifest via HTTP
pnpm exec hybld status                              # page counts, code-stale count
pnpm exec hybld status --reconcile --prune          # remove articles deleted in the CMS
pnpm exec vite build                                  # plugin mode: plain Vite build prerenders too
```

The serve mode exposes `POST /rebuild` (JSON scope: routes/slugs/ids/since) and
`POST /webhook/wordpress` (standard publish payloads), guarded by `--secret`.
With `--static --regen`, a request for an article page that was never built is
resolved through `pages.article.match` and built on demand (ISR-style).

Changing an article's `slug` in `articles.json` and rebuilding it (`--ids N`) demonstrates move handling: the old page is removed and `.hybld/redirects.json` gains an `old -> new` entry.

After every build, `.hybld/last-build.json` lists exactly which files were created, updated, and deleted, for precise deploy syncs and CDN invalidation.

## Using it in your own project

```bash
pnpm add -D hybld @hybld/adapter-wordpress
```

1. Add the placeholders `<!--app-head-->` and `<!--app-html-->` to your `index.html`.
2. Create `src/entry-server.tsx` default-exporting `({ route, pageType, data }) => ({ html, head })`.
3. Hydrate in your client entry from `window.__HYBLD_DATA__`.
4. Create `hybld.config.ts` (start from `examples/starter-react-vite/hybld.config.ts`, or `examples/demo-site/hybld.config.ts` for the full feature surface).

Next.js and Astro projects follow the same shape through their helper packages; copy `examples/starter-next` or `examples/starter-astro` as a base.

## Multi-language sites

Each language version is an ordinary page: put the locale in your route function (`route: (a) => '/' + a.lang + '/articles/' + a.slug + '/'`). Add `alternates: (a) => [{ lang, route }, ...]` to the collection to tell hybld which pages are translations of each other; it then writes hreflang links into the sitemap, hands the list to your renderer for head tags, and rebuilds the existing versions when a new translation appears.

## License

MIT, see [LICENSE](./LICENSE). Every published package carries its own copy.
