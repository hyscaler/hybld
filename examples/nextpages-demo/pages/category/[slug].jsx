import Head from "next/head";
import Link from "next/link";
import { hybldParams, hybldData } from "@hybld/next";

export async function getStaticPaths() {
  const params = await hybldParams("category", (_data, job) => ({ slug: job.item.slug }));
  return { paths: params.map((p) => ({ params: p })), fallback: false };
}

export async function getStaticProps({ params }) {
  const category = await hybldData("category", { slug: params.slug });
  return { props: { category } };
}

export default function CategoryPage({ category }) {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <Head>
        <title>{`${category.name} | Next Pages Demo`}</title>
      </Head>
      <p><Link href="/">Next Pages Demo</Link></p>
      <h1>Category: {category.name}</h1>
      <ul>
        {category.items.map((a) => (
          <li key={a.slug}>
            <Link href={`/articles/${a.slug}/`}>{a.title}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
