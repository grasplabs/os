import { cpSync, rmSync } from "node:fs";
import path from "node:path";

import buildScreenCompiler from "../../../packages/compiler/build.ts";

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

export default writeTestAssets;
