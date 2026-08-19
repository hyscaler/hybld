import { hybldData } from "@hybld/next";

export default async function Home() {
  // Singleton data: rides in every hybld scope file; falls back to the CMS
  // on plain `next build` / `next dev`.
  const { latest } = await hybldData("home");
  return (
    <>
      <h1>hybld starter: Next.js</h1>
      <p style={{ color: "#666" }}>
        Latest articles from a live public WordPress, each exported as its own static page.
      </p>
      <ul>
        {latest.map((a) => (
          <li key={a.slug}>
            <a href={`/articles/${a.slug}/`} dangerouslySetInnerHTML={{ __html: a.title }} />{" "}
            <span style={{ color: "#666", fontSize: "0.875rem" }}>({a.date.slice(0, 10)})</span>
          </li>
        ))}
      </ul>
    </>
  );
}
