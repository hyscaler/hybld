import { hydrateRoot } from "react-dom/client";
import { PAGES } from "./pages.js";

declare global {
  interface Window {
    __HYBLD_DATA__?: { route: string; pageType: string; data: any };
  }
}

const payload = window.__HYBLD_DATA__;
if (payload) {
  const Page = PAGES[payload.pageType];
  if (Page) {
    hydrateRoot(document.getElementById("root")!, <Page {...payload.data} />);
  }
}
