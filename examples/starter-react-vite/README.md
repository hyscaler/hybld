# hybld starter: React + Vite + a live public WordPress

Plain React (no meta-framework) prerendered incrementally by hybld, pulling
real articles from WP Tavern's public WordPress REST API. Clone, install, and
watch incremental static generation work against live data in under a minute.

## Run it

```bash
npm install           # or pnpm install; deps are the published hybld packages
pnpm run demo         # builds 12 articles + home into dist/, and seeds the incremental cursor
pnpm run demo         # again: everything skips (nothing changed upstream)
pnpm run sweep        # --since last-build: builds only what WP Tavern edited since
pnpm run serve        # serve dist/ locally with regen-on-miss
```

Target one article (what a CMS webhook would do):

```bash
npx hybld build --slugs <any-slug-from-the-home-page>
```

## Make it yours

Point it at your own WordPress and lift the polite limits:

```bash
CMS_URL=https://cms.your-site.com pnpm exec hybld build --all
```

## Courtesy note

The default data source is someone else's public server (~6,600 posts). The
scripts stay at `--limit 12` with low concurrency; please keep full builds
for your own `CMS_URL`.

Docs: https://www.npmjs.com/package/hybld
