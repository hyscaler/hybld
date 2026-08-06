import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;

export async function generateStaticParams() {
  return hybldParams("article", (_data, job) => ({ slug: job.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });
  return {
    title: `${article.title} | Next Demo`,
    description: article.excerpt.replace(/<[^>]*>/g, "").slice(0, 150),
  };
}

export default async function ArticlePage({ params }) {
  const { slug } = await params;
  const article = await hybldData("article", { slug });
  return (
    <article>
      <h1>{article.title}</h1>
      <p>
        <small>
          {article.date.slice(0, 10)} in <a href={`/category/${article.category}/`}>{article.category}</a>
        </small>
      </p>
      <div dangerouslySetInnerHTML={{ __html: article.html }} />
    </article>
  );
}
