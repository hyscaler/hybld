// Worker-thread renderer (FR-6): loads the user's SSR bundle once and renders
// pages on demand. Spawned by RenderPool with { bundlePath, bust } workerData.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const { bundlePath, bust } = workerData as { bundlePath: string; bust: number };

const mod: any = await import(`${pathToFileURL(bundlePath).href}?t=${bust}`);
const render = mod.default;
if (typeof render !== "function") {
  throw new Error("SSR bundle does not default-export a render function");
}

parentPort!.on("message", async ({ id, input }: { id: number; input: any }) => {
  try {
    const result = await render(input);
    const { html, head } = typeof result === "string" ? { html: result, head: "" } : result;
    parentPort!.postMessage({ id, html, head: head ?? "" });
  } catch (err: any) {
    parentPort!.postMessage({ id, error: err?.message || String(err) || "render failed" });
  }
});

parentPort!.postMessage({ ready: true });
