import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;

export async function generateStaticParams() {
  // Scoped during hybld runs (only the changed articles); full catalog on
  // plain `next build`. Derive params from job fields; the data argument is
  // undefined on plain builds by design.
  return hybldParams("article", (_data, job) => ({ slug: job.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const a = await hybldData("article", { slug });
  return {
    title: a.title.replace(/<[^>]+>/g, ""),
    description: a.excerpt?.replace(/<[^>]+>/g, "").trim().slice(0, 150),
  };
}

export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const a = await hybldData("article", { slug }); // scope-first: zero CMS calls during hybld runs
  return (
    <article>
      <p><a href="/">&larr; All articles</a></p>
      <h1 dangerouslySetInnerHTML={{ __html: a.title }} />
      <p style={{ color: "#666", fontSize: "0.875rem" }}>
        <time dateTime={a.date}>{a.date.slice(0, 10)}</time>
        {" · "}
        <a href={a.sourceUrl} rel="noopener">original at WP Tavern</a>
      </p>
      <div dangerouslySetInnerHTML={{ __html: a.html }} />
    </article>
  );
}
