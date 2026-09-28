import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assetContentKey } from "@grasp-os/shared/release";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { collectAssets, collectModules } from "./hash-lib.ts";

describe("release hashing", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "grasp-os-hash-test-"));
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("keys an asset by its contents and extension", async () => {
    const html = Buffer.from("<html></html>");
    await expect(assetContentKey(html, "dir/index.html")).resolves.toBe(
      "d4c01ae8630098078a961cef6cb9e3b3"
    );
    await expect(assetContentKey(html, "index.txt")).resolves.not.toBe(
      await assetContentKey(html, "index.html")
    );
  });

  it("fails on a bundled file it has no module type for", async () => {
    writeFileSync(path.join(dir, "index.js"), "export default {};\n");
    writeFileSync(path.join(dir, "mystery.dat"), "?");
    await expect(collectModules(dir)).rejects.toThrow(/mystery\.dat/u);
  });

  it("fails without exactly one ES module", async () => {
    writeFileSync(path.join(dir, "a.js"), "export default {};\n");
    writeFileSync(path.join(dir, "b.js"), "export default {};\n");
    await expect(collectModules(dir)).rejects.toThrow(/a\.js, b\.js/u);
  });

  it("refuses asset files that Wrangler reads as configuration", async () => {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "_headers"), "/*\n  X-Frame-Options: DENY\n");
    await expect(collectAssets(dir)).rejects.toThrow(/_headers/u);
  });
});
