"use client";
// Client-side elements that PROVE hydration works on incrementally built,
// statically exported pages: a scroll-driven reading-progress bar, a relative
// "time ago" that only JS can compute, and a clap button persisting to
// localStorage. If any of these respond in the browser, the page's JS chunks
// were merged and loaded correctly.
import { useEffect, useState } from "react";

export function ProgressBar() {
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      setPct(max > 0 ? Math.min(100, (el.scrollTop / max) * 100) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return <div className="progress-bar" style={{ width: `${pct}%` }} aria-hidden="true" />;
}

export function TimeAgo({ iso }) {
  const [label, setLabel] = useState(null);
  useEffect(() => {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    setLabel(
      mins < 60 ? `${mins} min ago`
      : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago`
      : `${Math.round(mins / (60 * 24))} d ago`
    );
  }, [iso]);
  // Server renders the absolute date; the client swaps in the relative label.
  return <span>{label ?? iso.slice(0, 10)}</span>;
}

export function ClapButton({ slug }) {
  const key = `claps:${slug}`;
  const [claps, setClaps] = useState(0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setClaps(Number(localStorage.getItem(key) ?? 0));
    setHydrated(true);
  }, [key]);
  const clap = () => {
    const next = claps + 1;
    setClaps(next);
    localStorage.setItem(key, String(next));
  };
  return (
    <div className="clap-row">
      <button className="clap-btn" onClick={clap} disabled={!hydrated}>
        👏 Clap{claps > 0 ? ` · ${claps}` : ""}
      </button>
      <p className="js-proof">
        JS check: {hydrated ? <b className="ok">hydrated ✓</b> : "hydrating..."} (count persists in
        localStorage across reloads)
      </p>
    </div>
  );
}
