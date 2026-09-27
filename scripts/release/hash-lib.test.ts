import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { cfAssetHash, collectAssets, collectModules } from "./hash-lib.ts";

describe("release hashing", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-hash-test-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("keys an asset by its contents and extension", () => {
    const html = Buffer.from("<html></html>");
    expect(cfAssetHash(html, "dir/index.html")).toBe(
      "d4c01ae8630098078a961cef6cb9e3b3"
    );
    expect(cfAssetHash(html, "index.txt")).not.toBe(
      cfAssetHash(html, "index.html")
    );
  });

  it("fails on a bundled file it has no module type for", () => {
    writeFileSync(path.join(dir, "index.js"), "export default {};\n");
    writeFileSync(path.join(dir, "mystery.dat"), "?");
    expect(() => collectModules(dir)).toThrow(/mystery\.dat/u);
  });

  it("fails without exactly one ES module", () => {
    writeFileSync(path.join(dir, "a.js"), "export default {};\n");
    writeFileSync(path.join(dir, "b.js"), "export default {};\n");
    expect(() => collectModules(dir)).toThrow(/a\.js, b\.js/u);
  });

  it("refuses asset files that Wrangler reads as configuration", () => {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "_headers"), "/*\n  X-Frame-Options: DENY\n");
    expect(() => collectAssets(dir)).toThrow(/_headers/u);
  });
});
