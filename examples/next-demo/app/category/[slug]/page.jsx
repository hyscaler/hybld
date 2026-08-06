import { hybldParams, hybldData } from "@hybld/next";

export const dynamicParams = false;

export async function generateStaticParams() {
  return hybldParams("category", (_data, job) => ({ slug: job.item.slug }));
}

export async function generateMetadata({ params }) {
  const { slug } = await params;
  const category = await hybldData("category", { slug });
  return { title: `${category?.name ?? slug} | Next Demo` };
}

export default async function CategoryPage({ params }) {
  const { slug } = await params;
  const category = await hybldData("category", { slug });
  return (
    <main>
      <h1>Category: {category.name}</h1>
      <ul>
        {category.items.map((a) => (
          <li key={a.slug}>
            <a href={`/articles/${a.slug}/`}>{a.title}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}
