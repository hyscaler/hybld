import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hybld } from "hybld/plugin";

export default defineConfig({
  // hybld() makes plain `vite build` also prerender the whole site
  // (experimental plugin mode). The hybld CLI works with or without it.
  plugins: [react(), hybld()],
});
