// Mock WordPress REST server for testing hybld without a real CMS.
// Data lives in articles.json next to this file and is re-read on every
// request, so editing that file simulates CMS changes (publish/edit/delete).
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(DIR, "articles.json");
const PORT = Number(process.env.PORT ?? 4399);

const CATEGORIES = [
  { id: 1, slug: "tech", name: "Tech" },
  { id: 2, slug: "life", name: "Life" },
  { id: 3, slug: "news", name: "News" },
];

// 1x1 transparent PNG served at /media/sample.png (for image localization tests).
const SAMPLE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function seed() {
  const articles = [];
  for (let i = 1; i <= 57; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    const day = String((i % 27) + 1).padStart(2, "0");
    const date = `2026-06-${day}T09:00:00`;
    const image =
      i === 5 ? `<p><img src="http://localhost:${PORT}/media/sample.png" alt="sample"></p>` : "";
    articles.push({
      id: i,
      slug: `demo-article-${i}`,
      status: "publish",
      date,
      modified: date,
      title: { rendered: `Demo Article ${i}: notes on ${cat.name.toLowerCase()}` },
      excerpt: { rendered: `<p>Short summary of demo article ${i} in the ${cat.name} category.</p>` },
      content: {
        rendered: `<p>This is the body of demo article <strong>${i}</strong>, filed under ${cat.name}.</p>${image}<p>It exists so hybld has something to prerender.</p>`,
      },
      category_slug: cat.slug,
      categories: [cat.id],
    });
  }
  // An unpublished draft, reachable only via status=any (preview builds).
  articles.push({
    id: 100,
    slug: "upcoming-draft",
    status: "draft",
    date: "2026-07-21T09:00:00",
    modified: "2026-07-21T09:00:00",
    title: { rendered: "Upcoming: a draft article" },
    excerpt: { rendered: "<p>Not published yet.</p>" },
    content: { rendered: "<p>This draft is only visible through preview builds.</p>" },
    category_slug: "news",
    categories: [3],
  });
  writeFileSync(DATA_FILE, JSON.stringify(articles, null, 2));
  return articles;
}

function load() {
  if (!existsSync(DATA_FILE)) return seed();
  return JSON.parse(readFileSync(DATA_FILE, "utf8"));
}

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(json);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const everything = load();
  const published = everything.filter((a) => a.status === "publish");

  if (path === "/wp-json/wp/v2/categories") {
    return send(
      res,
      200,
      CATEGORIES.map((c) => ({ ...c, count: published.filter((a) => a.category_slug === c.slug).length }))
    );
  }

  if (path === "/media/sample.png") {
    res.writeHead(200, { "content-type": "image/png" });
    return res.end(SAMPLE_PNG);
  }

  const itemMatch = path.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)$/);
  if (itemMatch) {
    const anyStatus = url.searchParams.get("status") === "any";
    const article = (anyStatus ? everything : published).find((a) => a.id === Number(itemMatch[1]));
    return article ? send(res, 200, article) : send(res, 404, { code: "rest_post_invalid_id" });
  }

  if (path === "/wp-json/wp/v2/posts") {
    // status=trash / status=any return non-public posts (WordPress requires
    // auth for these; the mock allows them so trackDeletes/preview work).
    const status = url.searchParams.get("status") ?? "publish";
    const pool =
      status === "trash"
        ? everything.filter((a) => a.status !== "publish")
        : status === "any"
          ? everything
          : published;
    let items = [...pool].sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first, WP default

    const slug = url.searchParams.get("slug");
    if (slug) items = items.filter((a) => a.slug === slug);

    const categorySlug = url.searchParams.get("category_slug");
    if (categorySlug) items = items.filter((a) => a.category_slug === categorySlug);

    const modifiedAfter = url.searchParams.get("modified_after");
    if (modifiedAfter) {
      const since = new Date(modifiedAfter).getTime();
      items = items.filter((a) => new Date(a.modified).getTime() > since);
    }

    const page = Number(url.searchParams.get("page") ?? 1);
    const perPage = Number(url.searchParams.get("per_page") ?? 10);
    const total = items.length;
    const slice = items.slice((page - 1) * perPage, page * perPage);
    return send(res, 200, slice, {
      "X-WP-Total": String(total),
      "X-WP-TotalPages": String(Math.ceil(total / perPage)),
    });
  }

  send(res, 404, { code: "rest_no_route", path });
});

server.listen(PORT, () => {
  load(); // ensure seeded
  console.log(`mock CMS listening on http://localhost:${PORT} (data: ${DATA_FILE})`);
});
