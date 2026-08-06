import { hybldData } from "@hybld/next";

export default async function HomePage() {
  const { latest } = await hybldData("home");
  return (
    <main>
      <h1>Latest articles (Next)</h1>
      <ul>
        {latest.map((a) => (
          <li key={a.slug}>
            <a href={`/articles/${a.slug}/`}>{a.title}</a>{" "}
            <small>
              ({a.date.slice(0, 10)}, <a href={`/category/${a.category}/`}>{a.category}</a>)
            </small>
          </li>
        ))}
      </ul>
    </main>
  );
}
