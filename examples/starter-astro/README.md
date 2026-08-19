# hybld starter: Astro + a live public WordPress

Astro built incrementally by hybld, pulling real articles from WP Tavern's
public WordPress REST API. Each hybld run executes ONE scoped `astro build`
covering only the changed pages and merges the result into the cumulative
`site/` directory.

## Run it

```bash
pnpm install          # from the repo root
pnpm run demo         # one scoped astro build: 12 articles + home into site/ (seeds the cursor)
pnpm run demo         # again: everything skips, no astro build at all
pnpm run sweep        # --since last-build: only what WP Tavern edited since
pnpm run serve        # serve site/ locally (regen answers 503 + Retry-After here)
```

Target one article (what a CMS webhook would do):

```bash
npx hybld build --slugs <any-slug-from-the-home-page>
```

## The wiring worth reading

- `astro.config.mjs`: one required line (`vite.ssr.external` keeps the hybld
  graph out of Astro's SSR bundle).
- `hybld.config.ts`: the content model.
- `src/pages/articles/[slug].astro`: `hybldPaths` in `getStaticPaths` with
  data flowing as props, that is the entire integration.

## Make it yours

```bash
CMS_URL=https://cms.your-site.com pnpm exec hybld build --all
```

## Courtesy note

The default data source is someone else's public server (~6,600 posts). The
scripts stay at `--limit 12` with low concurrency; keep full builds for your
own `CMS_URL`.

Docs: https://www.npmjs.com/package/@hybld/astro
