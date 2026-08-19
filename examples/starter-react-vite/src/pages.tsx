import React from "react";

export function ArticlePage({ title, html, date, sourceUrl }: {
  title: string; html: string; date: string; sourceUrl: string;
}) {
  return (
    <article>
      <p><a href="/">&larr; All articles</a></p>
      <h1 dangerouslySetInnerHTML={{ __html: title }} />
      <p className="meta">
        <time dateTime={date}>{date.slice(0, 10)}</time>
        {" · "}
        <a href={sourceUrl} rel="noopener">original at WP Tavern</a>
      </p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}

export function HomePage({ latest }: { latest: Array<{ slug: string; title: string; date: string }> }) {
  return (
    <>
      <h1>hybld starter: React + Vite</h1>
      <p className="meta">Latest articles from a live public WordPress, each prerendered as its own static page.</p>
      <ul>
        {latest.map((a) => (
          <li key={a.slug}>
            <a href={`/articles/${a.slug}/`} dangerouslySetInnerHTML={{ __html: a.title }} />{" "}
            <span className="meta">({a.date.slice(0, 10)})</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export const PAGES: Record<string, React.ComponentType<any>> = {
  article: ArticlePage,
  home: HomePage,
};
