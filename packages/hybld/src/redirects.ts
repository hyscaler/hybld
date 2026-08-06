import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Cumulative, chain-collapsed redirect map for slug changes (FR-17).
 * Stored as { "/old/": "/new/" }.
 */
export class Redirects {
  private map: Record<string, string> = {};
  private dirty = false;

  constructor(private file: string) {
    if (existsSync(file)) {
      try {
        this.map = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        this.map = {};
      }
    }
  }

  addMove(from: string, to: string): void {
    if (from === to) return;
    // Collapse chains: anything already pointing at `from` now points at `to`.
    for (const [old, target] of Object.entries(this.map)) {
      if (target === from) this.map[old] = to;
    }
    delete this.map[to]; // a route that exists again must not redirect away
    this.map[from] = to;
    this.dirty = true;
  }

  save(): boolean {
    if (!this.dirty) return false;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.map, null, 2));
    this.dirty = false;
    return true;
  }

  get entries(): Record<string, string> {
    return { ...this.map };
  }
}
