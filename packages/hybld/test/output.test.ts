import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutputWriter, routeToOutputPath } from "../dist/index.js";

describe("routeToOutputPath", () => {
  it("maps the root route to index.html", () => {
    expect(routeToOutputPath("/")).toBe("index.html");
  });
  it("maps directory routes to nested index.html", () => {
    expect(routeToOutputPath("/articles/my-post/")).toBe("articles/my-post/index.html");
    expect(routeToOutputPath("/articles/my-post")).toBe("articles/my-post/index.html");
  });
  it("keeps explicit .html routes as files", () => {
    expect(routeToOutputPath("/404.html")).toBe("404.html");
  });
});

describe("OutputWriter", () => {
  it("writes atomically, tracks created vs updated, prunes empty dirs on delete", () => {
    const dir = mkdtempSync(join(tmpdir(), "hybld-out-"));
    const writer = new OutputWriter(dir);

    writer.writePage("articles/a/index.html", "<p>one</p>");
    expect(readFileSync(join(dir, "articles/a/index.html"), "utf8")).toBe("<p>one</p>");
    expect(writer.created).toEqual(["articles/a/index.html"]);

    writer.writePage("articles/a/index.html", "<p>two</p>");
    expect(writer.updated).toEqual(["articles/a/index.html"]);

    writer.deletePage("articles/a/index.html");
    expect(existsSync(join(dir, "articles/a"))).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(writer.deletedFiles).toEqual(["articles/a/index.html"]);
  });

  it("writeIfChanged skips identical content", () => {
    const dir = mkdtempSync(join(tmpdir(), "hybld-out-"));
    const writer = new OutputWriter(dir);
    expect(writer.writeIfChanged("sitemap.xml", "<xml/>")).toBe(true);
    expect(writer.writeIfChanged("sitemap.xml", "<xml/>")).toBe(false);
    expect(writer.writeIfChanged("sitemap.xml", "<xml>2</xml>")).toBe(true);
  });
});
