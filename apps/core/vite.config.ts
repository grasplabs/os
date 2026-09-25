import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineProject } from "vite-plus";
import type { UserWorkspaceConfig } from "vite-plus";

import { bundleConnect } from "./test/build-connect.ts";
import { testSignIn } from "./test/sign-in-config.ts";

const coreMigrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/core/migrations`
);

/** The real connect Worker, for the CONNECT service binding. */
const connectScript = bundleConnect();

/** Shared by core and connect, as in a deployment. */
const capabilitySigningKey = "test-capability-signing-key-of-32-chars-or-more";

/**
 * The screen compiler's tests, which compile whole Apps. They run as their
 * own project (vite.screens.config.ts), after the others, so their long
 * compiles don't starve the light tests of CPU.
 */
export const screenTests = ["test/screen*.test.ts"];

/** Core's Worker test setup, shared by both of core's test projects. */
export const coreProject = (test: UserWorkspaceConfig["test"]) =>
  defineProject({
    test: {
      // Brings the core database up to the committed migrations.
      setupFiles: ["./test/apply-migrations.ts"],
      ...test,
    },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests run fully local, including in CI without Cloudflare credentials.
        remoteBindings: false,
        miniflare: {
          bindings: {
            ROUTER_SECRET: "test-router-secret",
            BETTER_AUTH_SECRET: "test-better-auth-secret-of-32-chars-or-more",
            CAPABILITY_SIGNING_KEY: capabilitySigningKey,
            ...testSignIn,
            // workerd doesn't implement Durable Object jurisdictions.
            DURABLE_OBJECT_JURISDICTION: "none",
            CORE_MIGRATIONS: coreMigrations,
          },
          // Deliver audit events at once instead of waiting to fill a batch.
          queueConsumers: { "grasp-os-audit": { maxBatchTimeout: 0 } },
          // A stand-in frontend and the screen compiler, written by the
          // screens project's global setup (test/global-setup.ts).
          assets: { directory: "./dist/test-assets" },
          // The real connect Worker behind the CONNECT service binding. Given
          // as a script: a `scriptPath` fails to start in the test pool.
          workers: [
            {
              name: "grasp-os-connect",
              modules: true,
              script: connectScript,
              compatibilityDate: "2026-09-15",
              compatibilityFlags: ["nodejs_compat"],
              bindings: { CAPABILITY_SIGNING_KEY: capabilitySigningKey },
            },
          ],
        },
      }),
    ],
  });

export default coreProject({ exclude: [...defaultExclude, ...screenTests] });
