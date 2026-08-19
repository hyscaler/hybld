import { hybldData } from "@hybld/next";
import { FilterableList } from "./components/FilterableList";

export default async function Home() {
  // Singleton data: rides in every hybld scope file; falls back to the CMS
  // on plain `next build` / `next dev`.
  const { latest } = await hybldData("home");
  return (
    <>
      <h1 className="page-title">Latest articles</h1>
      <p className="page-sub">
        Pulled from a live API and prerendered as static pages, one page per article, rebuilt only
        when it changes. The filter below runs client-side: hydration proof.
      </p>
      <FilterableList items={latest} />
    </>
  );
}
