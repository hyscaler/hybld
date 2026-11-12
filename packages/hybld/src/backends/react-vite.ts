import { Renderer } from "../renderer.js";
import type { RenderBackend, RenderJob, RenderedPage, RendererFactory, ResolvedConfig } from "../types.js";

/**
 * Owned rendering backend (strategy A): hybld runs the Vite client + SSR
 * builds and renders each page itself via the user's entry-server module.
 * This is the default backend; `render: { entry, workers }` configures it.
 */
export function reactVite(): RendererFactory {
  return {
    name: "react-vite",
    mode: "owned",
    create: (config, opts) => new ReactViteBackend(config, opts.externalClientBuild ?? false),
  };
}

class ReactViteBackend implements RenderBackend {
  readonly name = "react-vite";
  readonly mode = "owned" as const;
  readonly assetDirs = ["assets"];
  private renderer: Renderer;
  private workers: number;

  constructor(config: ResolvedConfig, externalClientBuild: boolean) {
    this.renderer = new Renderer(config, externalClientBuild);
    this.workers = config.render.workers;
  }

  prepare(opts: { clean: boolean }): Promise<void> {
    return this.renderer.ensureBuilt(opts.clean);
  }

  get assetGraphHash(): string {
    return this.renderer.assetGraphHash;
  }

  get assetFiles(): string[] {
    return this.renderer.currentAssetFiles;
  }

  async renderBatch(jobs: RenderJob[], opts: { noindex?: boolean } = {}): Promise<RenderedPage[]> {
    const results: RenderedPage[] = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= jobs.length) return;
        const job = jobs[i];
        try {
          const html = await this.renderer.renderPage(
            { route: job.route, pageType: job.pageType, data: job.data, alternates: job.alternates },
            { noindex: opts.noindex }
          );
          results[i] = { route: job.route, kind: "html", html };
        } catch (err: any) {
          results[i] = { route: job.route, kind: "failed", error: err?.message ?? String(err) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.workers, jobs.length)) }, worker));
    return results;
  }

  pageSidecars(): string[] {
    return [];
  }

  destroy(): void {
    this.renderer.destroy();
  }
}
