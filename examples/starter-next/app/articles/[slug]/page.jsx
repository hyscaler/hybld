import { hybldParams, hybldData } from "@hybld/next";
import { ProgressBar, TimeAgo, ClapButton } from "../../components/ArticleExtras";

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
      <ProgressBar />
      <a className="crumb" href="/">&larr; All articles</a>
      <h1 className="article-title" dangerouslySetInnerHTML={{ __html: a.title }} />
      <div className="article-meta">
        <span className="badge">Article</span>
        <span>
          <time dateTime={a.date}>
            <TimeAgo iso={a.date} />
          </time>
        </span>
        <a href={a.sourceUrl} rel="noopener">original source</a>
      </div>
      {a.image ? <img className="hero" src={a.image} alt="" /> : null}
      <div className="prose" dangerouslySetInnerHTML={{ __html: a.html }} />
      <ClapButton slug={slug} />
    </article>
  );
}
