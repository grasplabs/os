import { readFileSync } from "node:fs";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineProject } from "vite-plus";
import type { UserWorkspaceConfig } from "vite-plus";

import { connectBundle } from "./test/build-connect.ts";
import { testSignIn } from "./test/sign-in-config.ts";

const coreMigrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/core/migrations`
);
const knowledgeMigrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/knowledge/migrations`
);
const connectMigrations = await readD1Migrations(
  `${import.meta.dirname}/../connect/src/db/migrations`
);

/** Shared by core and connect, as in a deployment. */
const capabilitySigningKey = "test-capability-signing-key-of-32-chars-or-more";

/**
 * The tests that run the compiler on whole Apps: the screen compiler's,
 * and the App sandbox's, which builds each App's server code. They run as
 * their own project (vite.screens.config.ts), after the others, so their
 * long compiles don't starve the light tests of CPU.
 */
export const screenTests = ["test/screen*.test.ts", "test/app-sandbox.test.ts"];

/** Core's Worker test setup, shared by both of core's test projects. */
export const coreProject = (test: UserWorkspaceConfig["test"]) =>
  defineProject({
    test: {
      // Writes the assets the tests serve and bundles connect, once per run,
      // so each project also runs on its own.
      globalSetup: ["./test/global-setup.ts"],
      // Brings the D1 databases up to the committed migrations.
      setupFiles: ["./test/apply-migrations.ts"],
      ...test,
    },
    plugins: [
      // Read when the pool starts, after the global setup wrote the bundle.
      cloudflareTest(() => ({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests run fully local, including in CI without Cloudflare credentials.
        remoteBindings: false,
        miniflare: {
          bindings: {
            ROUTER_SECRET: "test-router-secret",
            BETTER_AUTH_SECRET: "test-better-auth-secret-of-32-chars-or-more",
            CAPABILITY_SIGNING_KEY: capabilitySigningKey,
            ...testSignIn,
            // Every flagged feature on; features.test.ts switches them off.
            FEATURES: { apps: true, permissions: true, knowledge: true },
            // workerd doesn't implement Durable Object jurisdictions.
            DURABLE_OBJECT_JURISDICTION: "none",
            // So the test of a call that never ends doesn't wait a minute.
            APP_CALL_TIMEOUT_MS: "10000",
            CORE_MIGRATIONS: coreMigrations,
            KNOWLEDGE_MIGRATIONS: knowledgeMigrations,
            CONNECT_MIGRATIONS: connectMigrations,
          },
          // Connect's database, as CONNECT_DB, so the setup can migrate it.
          d1Databases: { CONNECT_DB: "grasp-os-connect" },
          // Deliver audit events at once instead of waiting to fill a batch.
          queueConsumers: { "grasp-os-audit": { maxBatchTimeout: 0 } },
          // A stand-in frontend and the screen compiler, written by the
          // global setup.
          assets: { directory: "./dist/test-assets" },
          // The real connect Worker behind the CONNECT service binding,
          // bundled by the global setup. Given as a script: a `scriptPath`
          // fails to start in the test pool.
          workers: [
            {
              name: "grasp-os-connect",
              modules: true,
              script: readFileSync(connectBundle, "utf-8"),
              compatibilityDate: "2026-09-15",
              compatibilityFlags: [
                "nodejs_compat",
                "global_fetch_strictly_public",
              ],
              bindings: { CAPABILITY_SIGNING_KEY: capabilitySigningKey },
              d1Databases: { DB: "grasp-os-connect" },
              queueProducers: { AUDIT_QUEUE: "grasp-os-audit" },
            },
          ],
        },
      })),
    ],
  });

export default coreProject({ exclude: [...defaultExclude, ...screenTests] });
