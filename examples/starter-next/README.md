# hybld starter: Next.js (static export) + a live public WordPress

Next.js App Router in `output: "export"` mode, built incrementally by hybld,
pulling real articles from WP Tavern's public WordPress REST API. Each hybld
run executes ONE scoped `next build` covering only the changed pages and
merges the result into the cumulative `site/` directory.

## Run it

```bash
pnpm install          # from the repo root
pnpm run demo         # one scoped next build: 12 articles + home into site/
pnpm run demo         # again: everything skips, no next build at all
pnpm run sweep        # --since last-build: only what WP Tavern edited since
pnpm run serve        # serve site/ locally (regen answers 503 + Retry-After here)
```

Target one article (what a CMS webhook would do):

```bash
npx hybld build --slugs <any-slug-from-the-home-page>
```

## The wiring worth reading

- `next.config.mjs`: the four required settings (export, trailingSlash,
  unoptimized images, serverExternalPackages).
- `hybld.config.mjs`: the content model. Must be `.mjs` (Next build workers
  cannot import TS configs).
- `app/articles/[slug]/page.jsx`: `hybldParams` in `generateStaticParams`,
  `hybldData` for props, that is the entire integration.

## Make it yours

```bash
CMS_URL=https://cms.your-site.com pnpm exec hybld build --all
```

## Courtesy note

The default data source is someone else's public server (~6,600 posts). The
scripts stay at `--limit 12` with low concurrency; keep full builds for your
own `CMS_URL`, and always build through hybld (a plain `next build` would
enumerate the full remote catalog).

Docs: https://www.npmjs.com/package/@hybld/next
