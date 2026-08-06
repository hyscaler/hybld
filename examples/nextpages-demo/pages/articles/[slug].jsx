import Head from "next/head";
import Link from "next/link";
import { hybldParams, hybldData } from "@hybld/next";

export async function getStaticPaths() {
  const params = await hybldParams("article", (_data, job) => ({ slug: job.slug }));
  return { paths: params.map((p) => ({ params: p })), fallback: false };
}

export async function getStaticProps({ params }) {
  const article = await hybldData("article", { slug: params.slug });
  return { props: { article } };
}

export default function ArticlePage({ article }) {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <Head>
        <title>{`${article.title} | Next Pages Demo`}</title>
        <meta name="description" content={article.excerpt.replace(/<[^>]*>/g, "").slice(0, 150)} />
      </Head>
      <p><Link href="/">Next Pages Demo</Link></p>
      <article>
        <h1>{article.title}</h1>
        <p>
          <small>
            {article.date.slice(0, 10)} in <Link href={`/category/${article.category}/`}>{article.category}</Link>
          </small>
        </p>
        <div dangerouslySetInnerHTML={{ __html: article.html }} />
      </article>
    </main>
  );
}
