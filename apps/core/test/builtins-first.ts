/**
 * The release's built-ins, installed once per runtime before any test runs
 * (start-each-file.ts). Core installs them in the background on the first
 * request an isolate serves (src/builtins.ts), and files share one isolate
 * (`isolate: false` in vite.config.ts): left to a test's first request,
 * that install would write Apps, skills and audit events while the test
 * checks what was written. A first request here, waited for, installs
 * them, and the isolate counts it done, so no later request starts
 * another. start-each-file.ts then empties storage, so every file starts
 * without them. builtins.test.ts tests the install with installers of its
 * own, each an isolate's.
 */
import { routerSecretHeader } from "@grasp-os/shared/router";
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";

import { builtins, fingerprintOf, release } from "../src/builtins.ts";
import worker from "../src/index.ts";

/** Evaluated once per runtime, as this module is. */
let installed = false;

/**
 * Serves the isolate's first request, and waits for the install it starts,
 * the first time only: whether it installed now. Throws if the install
 * didn't finish, which would leave a later request to start another.
 */
export const installBuiltinsFirst = async (): Promise<boolean> => {
  if (installed) {
    return false;
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://core/health", {
      headers: { [routerSecretHeader]: env.ROUTER_SECRET },
    }),
    env,
    ctx
  );
  await waitOnExecutionContext(ctx);
  const stored = await runInDurableObject(
    builtins(env),
    async (_instance, state) => await state.storage.get("installed")
  );
  if (!response.ok || stored !== (await fingerprintOf(release))) {
    throw new Error("The first request didn't install the built-ins");
  }
  installed = true;
  return true;
};
