import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import buildScreenCompiler from "../../../packages/compiler/build.ts";
import { bundleConnect, connectBundle } from "./build-connect.ts";

/**
 * The static assets core's tests serve: a stand-in frontend, so tests don't
 * wait for a build of apps/web, and the screen compiler, as core's deploy
 * puts it next to the frontend.
 */
const testAssets = path.join(import.meta.dirname, "../dist/test-assets");

const writeTestAssets = async (): Promise<void> => {
  rmSync(testAssets, { recursive: true, force: true });
  cpSync(path.join(import.meta.dirname, "fixtures/assets"), testAssets, {
    recursive: true,
  });
  await buildScreenCompiler(testAssets);
};

const prepare = async (): Promise<void> => {
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
 * Before any test of a project: writes the test assets and bundles the
 * connect Worker, which the project's config reads when its pool starts.
 */
const setup = async (): Promise<void> => {
  globalThis.coreTestSetup ??= prepare();
  await globalThis.coreTestSetup;
};

export default setup;
