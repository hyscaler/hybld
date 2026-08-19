import React from "react";
import { hydrateRoot } from "react-dom/client";
import { PAGES } from "./pages";

const p = (window as any).__HYBLD_DATA__;
if (p) {
  const Page = PAGES[p.pageType];
  if (Page) hydrateRoot(document.getElementById("root")!, <Page {...p.data} />);
}
