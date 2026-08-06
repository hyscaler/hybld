import type { ReactNode } from "react";
import { useState } from "react";

function Layout({ children }: { children: ReactNode }) {
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      <header style={{ borderBottom: "1px solid #ddd", paddingBottom: 8, marginBottom: 16 }}>
        <a href="/" style={{ textDecoration: "none", color: "inherit" }}>
          <strong>Hybld Demo v3</strong>
        </a>
      </header>
      {children}
      <LikeButton />
    </div>
  );
}

/** Interactive island proving hydration works on prerendered pages. */
function LikeButton() {
  const [likes, setLikes] = useState(0);
  return (
    <footer style={{ marginTop: 24, borderTop: "1px solid #ddd", paddingTop: 8 }}>
      <button onClick={() => setLikes(likes + 1)}>Like ({likes})</button>
    </footer>
  );
}

export interface ListItem {
  slug: string;
  title: string;
  date: string;
  category: string;
}

function ArticleList({ items }: { items: ListItem[] }) {
  return (
    <ul>
      {items.map((a) => (
        <li key={a.slug}>
          <a href={`/articles/${a.slug}/`}>{a.title}</a>{" "}
          <small>
            ({a.date.slice(0, 10)}, <a href={`/category/${a.category}/`}>{a.category}</a>)
          </small>
        </li>
      ))}
    </ul>
  );
}

export function ArticlePage(props: {
  title: string;
  html: string;
  date: string;
  category: string;
  slug: string;
}) {
  return (
    <Layout>
      <article>
        <h1>{props.title}</h1>
        <p>
          <small>
            {props.date.slice(0, 10)} in <a href={`/category/${props.category}/`}>{props.category}</a>
          </small>
        </p>
        <div dangerouslySetInnerHTML={{ __html: props.html }} />
      </article>
    </Layout>
  );
}

export function HomePage(props: { latest: ListItem[] }) {
  return (
    <Layout>
      <h1>Latest articles</h1>
      <ArticleList items={props.latest} />
    </Layout>
  );
}

export function CategoryPage(props: {
  name: string;
  slug: string;
  page: number;
  totalPages: number;
  items: ListItem[];
}) {
  const pageUrl = (p: number) => (p === 1 ? `/category/${props.slug}/` : `/category/${props.slug}/page/${p}/`);
  return (
    <Layout>
      <h1>
        Category: {props.name}
        {props.page > 1 ? ` (page ${props.page})` : ""}
      </h1>
      <ArticleList items={props.items} />
      <nav>
        {props.page > 1 && <a href={pageUrl(props.page - 1)}>&laquo; Newer</a>}{" "}
        {props.page < props.totalPages && <a href={pageUrl(props.page + 1)}>Older &raquo;</a>}
      </nav>
    </Layout>
  );
}

export function NotFoundPage() {
  return (
    <Layout>
      <h1>Page not found</h1>
      <p>
        The page you were looking for does not exist. <a href="/">Back to the homepage.</a>
      </p>
    </Layout>
  );
}

export const PAGES: Record<string, (props: any) => ReactNode> = {
  article: ArticlePage,
  home: HomePage,
  category: CategoryPage,
  notFound: NotFoundPage,
};
