import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redirects } from "../dist/index.js";

describe("Redirects", () => {
  const fresh = () => new Redirects(join(mkdtempSync(join(tmpdir(), "hybld-red-")), "redirects.json"));

  it("records a move", () => {
    const r = fresh();
    r.addMove("/a/", "/b/");
    expect(r.entries).toEqual({ "/a/": "/b/" });
  });

  it("collapses chains a -> b -> c into a -> c", () => {
    const r = fresh();
    r.addMove("/a/", "/b/");
    r.addMove("/b/", "/c/");
    expect(r.entries).toEqual({ "/a/": "/c/", "/b/": "/c/" });
  });

  it("removes a redirect when its target route exists again", () => {
    const r = fresh();
    r.addMove("/a/", "/b/");
    r.addMove("/b/", "/a/"); // moved back
    expect(r.entries["/b/"]).toBe("/a/");
    expect(r.entries["/a/"]).toBeUndefined();
  });

  it("persists and reloads", () => {
    const file = join(mkdtempSync(join(tmpdir(), "hybld-red-")), "redirects.json");
    const r1 = new Redirects(file);
    r1.addMove("/old/", "/new/");
    expect(r1.save()).toBe(true);
    expect(r1.save()).toBe(false); // not dirty anymore
    const r2 = new Redirects(file);
    expect(r2.entries).toEqual({ "/old/": "/new/" });
  });
});
