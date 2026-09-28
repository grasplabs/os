/**
 * The release manifest, generated from the real wrangler.jsonc of core and
 * connect (fixture-release.ts). Changing either config fails the golden test until the golden file is
 * regenerated (`vp test -u scripts/release`): a deliberate decision about
 * how the change reaches client accounts.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { assetKey, moduleKey } from "@grasp-os/shared/release";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { builds, fixtureBuild, info, rawConfig } from "./fixture-release.ts";
import { stableStringify } from "./hash-lib.ts";
import {
  assertReleaseDir,
  generateManifest,
  parseWranglerConfig,
  verifyRelease,
  writeRelease,
} from "./manifest-lib.ts";

const fixture = await builds();

/** Every string anywhere in `value`. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
};

describe("the release manifest", () => {
  it("matches the golden manifest for the real wrangler configs", async () => {
    await expect(
      stableStringify(generateManifest(info, fixture))
    ).toMatchFileSnapshot("testdata/golden-manifest.json");
  });

  it("leaves only placeholders the console knows", () => {
    const { workers } = generateManifest(info, fixture);
    const tokens = Object.values(workers)
      .flatMap((worker) => stringsIn(worker.bindings))
      .filter((value) => value.includes("$"));
    expect(tokens).toStrictEqual([
      "$D1_DB_ID",
      "$D1_DB_ID",
      "$D1_KNOWLEDGE_ID",
    ]);
  });

  it("fails the build on a wrangler.jsonc key it doesn't handle", () => {
    const core = rawConfig("core");
    expect(() =>
      parseWranglerConfig("core", { ...core, vars: { A: "b" } })
    ).toThrow(/vars/u);
    expect(() =>
      parseWranglerConfig("core", {
        ...core,
        durable_objects: {
          bindings: [{ name: "X", class_name: "X", script_name: "elsewhere" }],
        },
      })
    ).toThrow(/script_name/u);
    expect(() =>
      parseWranglerConfig("core", {
        ...core,
        observability: { enabled: true, destinations: ["an-account-sink"] },
      })
    ).toThrow(/destinations/u);
  });

  it("refuses an R2 bucket outside the EU", () => {
    expect(() =>
      parseWranglerConfig("core", {
        ...rawConfig("core"),
        r2_buckets: [{ binding: "FILES", bucket_name: "grasp-os-files" }],
      })
    ).toThrow(/jurisdiction/u);
  });

  it("refuses a service binding to a Worker outside the release", async () => {
    const core = await fixtureBuild("core");
    expect(() => generateManifest(info, [core])).toThrow(/grasp-os-connect/u);
  });

  it("refuses Workers on different compatibility dates", () => {
    const [connect, core] = fixture;
    if (connect === undefined || core === undefined) {
      throw new Error("expected two builds");
    }
    const older = {
      ...connect,
      config: { ...connect.config, compatibility_date: "2026-01-01" },
    };
    expect(() => generateManifest(info, [older, core])).toThrow(
      /compatibility date/u
    );
  });

  it("refuses a release id that isn't a plain R2 prefix", () => {
    expect(() =>
      generateManifest({ ...info, releaseId: "../r000001-0000000" }, fixture)
    ).toThrow(/releaseId/u);
  });

  it("refuses a build without its D1 migrations or static assets", () => {
    const [connect, core] = fixture;
    if (connect === undefined || core === undefined) {
      throw new Error("expected two builds");
    }
    expect(() =>
      generateManifest(info, [connect, { ...core, d1Migrations: {} }])
    ).toThrow(/no migrations collected for DB/u);
    expect(() =>
      generateManifest(info, [
        connect,
        { ...core, d1Migrations: { DB: [], KNOWLEDGE: [] } },
      ])
    ).toThrow(/no migrations collected for DB/u);
    const { assets: _assets, ...coreWithoutAssets } = core;
    expect(() => generateManifest(info, [connect, coreWithoutAssets])).toThrow(
      /assets/u
    );
  });
});

describe("a written release", () => {
  let out = "";
  const manifest = generateManifest(info, fixture);
  const [coreModule] = manifest.workers.core?.modules ?? [];
  const [assetHash] = Object.keys(manifest.assets);
  if (coreModule === undefined || assetHash === undefined) {
    throw new Error("expected a core module and an asset");
  }

  beforeEach(() => {
    out = mkdtempSync(path.join(tmpdir(), "grasp-os-release-test-"));
    writeRelease(out, manifest, fixture);
  });

  afterEach(() => {
    rmSync(out, { force: true, recursive: true });
  });

  it("verifies against its manifest", async () => {
    await expect(verifyRelease(out)).resolves.toHaveProperty(
      "manifest",
      manifest
    );
  });

  it("replaces an earlier release in the same directory", async () => {
    const stale = path.join(out, moduleKey("0".repeat(64)));
    writeFileSync(stale, "from an earlier release");
    writeRelease(out, manifest, fixture);
    expect(existsSync(stale)).toBeFalsy();
    await expect(verifyRelease(out)).resolves.toHaveProperty(
      "manifest",
      manifest
    );
  });

  it("creates the directory when it's absent", async () => {
    const nested = path.join(out, "nested", "release");
    writeRelease(nested, manifest, fixture);
    await expect(verifyRelease(nested)).resolves.toHaveProperty(
      "manifest",
      manifest
    );
  });

  it("keeps the previous release when the next build fails", async () => {
    // What build-release does: check --out first, build, then write.
    assertReleaseDir(out);
    expect(() =>
      generateManifest({ ...info, commit: "not a commit" }, fixture)
    ).toThrow(/commit/u);
    await expect(verifyRelease(out)).resolves.toHaveProperty(
      "manifest",
      manifest
    );
  });

  it("refuses a directory that isn't a release before building", () => {
    const other = mkdtempSync(path.join(tmpdir(), "grasp-os-not-a-release-"));
    try {
      writeFileSync(path.join(other, "keep.txt"), "someone's work");
      expect(() => {
        assertReleaseDir(other);
      }).toThrow(/refusing to delete it/u);
      expect(() => {
        assertReleaseDir(path.join(other, "absent"));
      }).not.toThrow();
    } finally {
      rmSync(other, { force: true, recursive: true });
    }
  });

  it("refuses to replace a directory that isn't a release", () => {
    const other = mkdtempSync(path.join(tmpdir(), "grasp-os-not-a-release-"));
    try {
      writeFileSync(path.join(other, "keep.txt"), "someone's work");
      expect(() => {
        writeRelease(other, manifest, fixture);
      }).toThrow(/refusing to delete it/u);
      expect(readFileSync(path.join(other, "keep.txt"), "utf-8")).toBe(
        "someone's work"
      );
      expect(existsSync(path.join(other, "manifest.json"))).toBeFalsy();
    } finally {
      rmSync(other, { force: true, recursive: true });
    }
  });

  it("fails verification when a module changed", async () => {
    writeFileSync(path.join(out, moduleKey(coreModule.sha256)), "tampered");
    await expect(verifyRelease(out)).rejects.toThrow(/doesn't match its hash/u);
  });

  it("fails verification when an asset changed or is missing", async () => {
    const asset = path.join(out, assetKey(assetHash));
    writeFileSync(asset, "tampered");
    await expect(verifyRelease(out)).rejects.toThrow(/doesn't match its hash/u);
    unlinkSync(asset);
    await expect(verifyRelease(out)).rejects.toThrow(/missing/u);
  });

  it("checks every asset index entry, served or not, inside the release", async () => {
    const write = (assets: Record<string, unknown>): void => {
      writeFileSync(
        path.join(out, "manifest.json"),
        stableStringify({ ...manifest, assets })
      );
    };
    const [hash, blob] = Object.entries(manifest.assets)[0] ?? [];
    if (hash === undefined || blob === undefined) {
      throw new Error("expected an asset");
    }
    write({ ...manifest.assets, [hash]: { ...blob, r2Key: "../../outside" } });
    await expect(verifyRelease(out)).rejects.toThrow(/content address/u);

    const unserved = "f".repeat(32);
    writeFileSync(path.join(out, assetKey(unserved)), "served by nothing");
    write({
      ...manifest.assets,
      [unserved]: { size: 17, r2Key: assetKey(unserved) },
    });
    await expect(verifyRelease(out)).rejects.toThrow(/no Worker serves/u);
  });

  it("fails verification when the manifest points a blob elsewhere", async () => {
    const moved = readFileSync(
      path.join(out, "manifest.json"),
      "utf-8"
    ).replace(
      `"r2Key": "${moduleKey(coreModule.sha256)}"`,
      `"r2Key": "${assetKey(assetHash)}"`
    );
    writeFileSync(path.join(out, "manifest.json"), moved);
    await expect(verifyRelease(out)).rejects.toThrow(/content address/u);
  });
});
