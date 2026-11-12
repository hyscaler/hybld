# Examples

Two kinds of apps live here. They look similar but serve different purposes; both are needed.

## Starters (start here if you are evaluating hybld)

User-facing templates that depend on the **published hybld packages** from npm and pull real articles from a live public WordPress API (WP Tavern). Copy one out of the repo and it works standalone.

| Folder | Stack |
| -------- | ------- |
| `starter-react-vite` | Plain React + Vite (the owned backend) |
| `starter-next` | Next.js App Router, static export |
| `starter-astro` | Astro |

Each: `pnpm run demo` (bounded live build that also seeds the incremental cursor), `pnpm run sweep` (incremental `--since last-build`), `pnpm run serve` (local hosting with regen-on-miss).

## Internal demos (development fixtures, not templates)

E2e test apps that depend on the **local workspace packages** (`workspace:*`) and a bundled **mock WordPress CMS**, so they are deterministic, offline, and exercise unpublished code. CI's e2e smoke runs `demo-site`. Do not copy these as project templates; copy a starter.

| Folder | Covers |
| -------- | -------- |
| `demo-site` | React + Vite backend, full feature surface (categories, pagination, previews, images); also hosts the mock CMS (`mock-cms/server.mjs`, port 4399) used by all demos |
| `next-demo` | Next.js App Router backend |
| `nextpages-demo` | Next.js **Pages Router** (the only e2e for `_next/data` buildId fan-out) |
| `astro-demo` | Astro backend |
| `sveltekit-demo` | SvelteKit backend (adapter-static) |
| `nuxt-demo` | Nuxt backend (module and `useHybldData`) |

Run a demo: start the mock CMS first (`cd demo-site && node mock-cms/server.mjs`), then `npx hybld build --all` in the demo's folder.

Rule of thumb: starters prove the *published* packages against *live* data; demos prove the *local* code against *controlled* data. A change is done when both agree.
