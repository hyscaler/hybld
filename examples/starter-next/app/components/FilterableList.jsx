"use client";
// Client-side filter over the statically rendered article list: typing in the
// box is instant proof that hydration and interactivity work on the home page.
import { useState } from "react";

export function FilterableList({ items }) {
  const [q, setQ] = useState("");
  const strip = (s) => s.replace(/<[^>]+>/g, "");
  const shown = items.filter((a) => strip(a.title).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <input
        className="filter-input"
        type="search"
        placeholder="Filter articles (client-side JS)..."
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Filter articles"
      />
      <ul className="card-list">
        {shown.map((a) => (
          <li key={a.slug}>
            <a className="card" href={`/articles/${a.slug}/`}>
              <span className="title" dangerouslySetInnerHTML={{ __html: a.title }} />
              <span className="meta">{a.date?.slice(0, 10)}</span>
            </a>
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="empty-note">No articles match "{q}".</p>}
    </>
  );
}
