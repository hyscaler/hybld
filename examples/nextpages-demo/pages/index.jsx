import Link from "next/link";
import { hybldData } from "@hybld/next";

export async function getStaticProps() {
  const home = await hybldData("home");
  return { props: { home } };
}

export default function HomePage({ home }) {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <h1>Latest articles (Next Pages Router)</h1>
      <ul>
        {home.latest.map((a) => (
          <li key={a.slug}>
            <Link href={`/articles/${a.slug}/`}>{a.title}</Link>{" "}
            <small>
              ({a.date.slice(0, 10)}, <Link href={`/category/${a.category}/`}>{a.category}</Link>)
            </small>
          </li>
        ))}
      </ul>
    </main>
  );
}
