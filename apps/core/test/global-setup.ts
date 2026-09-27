import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import buildScreenCompiler from "../../../packages/compiler/build.ts";
import {
  blueprintsDir,
  testBlueprintsModule,
  writeBlueprints,
} from "../build-blueprints.ts";
import buildExtractor from "../build-extractor.ts";
import { bundleConnect, connectBundle } from "./build-connect.ts";

/**
 * The static assets core's tests serve: a stand-in frontend, so tests don't
 * wait for a build of apps/web, and the screen compiler and the extractor,
 * as core's deploy puts them next to the frontend.
 */
const testAssets = path.join(import.meta.dirname, "../dist/test-assets");

const writeTestAssets = async (): Promise<void> => {
  rmSync(testAssets, { recursive: true, force: true });
  cpSync(path.join(import.meta.dirname, "fixtures/assets"), testAssets, {
    recursive: true,
  });
  await buildScreenCompiler(testAssets);
  await buildExtractor(testAssets);
};

const prepare = async (): Promise<void> => {
  // The release's built-ins, and one of the tests' own, so the install
  // has a blueprint to write while the release ships none: into the
  // tests' module, never the one core's build ships.
  writeBlueprints(
    [blueprintsDir, path.join(import.meta.dirname, "fixtures/blueprints")],
    testBlueprintsModule
  );
  await writeTestAssets();
  mkdirSync(path.dirname(connectBundle), { recursive: true });
  writeFileSync(connectBundle, await bundleConnect());
};

declare global {
  // Both of core's projects run this setup, in one process: the work is
  // done once per run, by whichever comes first.
  var coreTestSetup: Promise<void> | undefined;
}

/**
 * Before any test of a project: embeds the built-in blueprints, writes
 * the test assets and bundles the connect Worker, which the project's config reads when its pool starts.
 */
const setup = async (): Promise<void> => {
  globalThis.coreTestSetup ??= prepare();
  await globalThis.coreTestSetup;
};

export default setup;
