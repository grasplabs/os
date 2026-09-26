import { readFileSync } from "node:fs";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defaultExclude, defineProject } from "vite-plus";
import type { UserWorkspaceConfig } from "vite-plus";

import { connectBundle } from "./test/build-connect.ts";
import {
  connectClient,
  connectProvidersScript,
} from "./test/connect-providers.ts";
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

/**
 * The engine's step limit in tests: well above what any test workflow
 * takes, but low enough to reach.
 */
const testStepLimit = 60;

/** Shared by core and connect, as in a deployment. */
const capabilitySigningKey = "test-capability-signing-key-of-32-chars-or-more";

/**
 * The tests that run the compiler on whole Apps: the screen compiler's,
 * and the App sandbox's, which builds each App's server code. They run as
 * their own project (vite.screens.config.ts), after the others, so their
 * long compiles don't starve the light tests of CPU.
 */
export const screenTests = [
  "test/screen*.test.ts",
  "test/app-sandbox.test.ts",
  "test/workflows.test.ts",
  "test/decisions.test.ts",
  "test/decisions-switched-off.test.ts",
  "test/workflow-params.test.ts",
];

/** Core's Worker test setup, shared by both of core's test projects. */
export const coreProject = (test: UserWorkspaceConfig["test"]) =>
  defineProject({
    test: {
      // Writes the assets the tests serve and bundles connect, once per run,
      // so each project also runs on its own.
      globalSetup: ["./test/global-setup.ts"],
      // Brings the D1 databases up to the committed migrations.
      setupFiles: ["./test/apply-migrations.ts"],
      // Logs go straight to workerd's output, not to Vitest over RPC. A log
      // from another request (a workflow run, a queue batch, a Durable
      // Object) can't use the test's socket, so the pool holds it until the
      // test next sends something; one logged after the file's last message
      // was never sent, and the file waited for its reply forever.
      disableConsoleIntercept: true,
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
            // The audit log works out when to purge archives from its own
            // env: the shortest archive retention the console may set.
            AUDIT_ARCHIVE_RETENTION_DAYS: "365",
            ...testSignIn,
            // Every flagged feature on; features.test.ts switches them off.
            FEATURES: {
              apps: true,
              permissions: true,
              knowledge: true,
              connections: true,
              workflows: true,
              decisions: true,
              screens: true,
              members: true,
              audit: true,
              audit_retention: true,
              approvals: true,
            },
            // The gateway runs call the model through; tests fake the AI binding.
            MODEL_GATEWAY: {
              gateway: "grasp-os-test",
              models: ["workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast"],
            },
            // workerd doesn't implement Durable Object jurisdictions.
            DURABLE_OBJECT_JURISDICTION: "none",
            // So the test of a call that never ends doesn't wait a minute.
            APP_CALL_TIMEOUT_MS: "10000",
            // The engine's step limit, lowered below (`workflows`) so a test
            // reaches it; core must know it too.
            WORKFLOW_STEP_LIMIT: String(testStepLimit),
            // So a run held by a kill switch checks again at once.
            WORKFLOW_OFF_WAIT_MS: "250",
            CORE_MIGRATIONS: coreMigrations,
            KNOWLEDGE_MIGRATIONS: knowledgeMigrations,
            CONNECT_MIGRATIONS: connectMigrations,
          },
          // The dispatcher as wrangler.jsonc has it, with a step limit a
          // test can reach.
          workflows: {
            WORKFLOWS: {
              name: "grasp-os-workflows",
              className: "WorkflowDispatcher",
              stepLimit: testStepLimit,
            },
          },
          // Connect's database, as CONNECT_DB, so the setup can migrate it.
          d1Databases: { CONNECT_DB: "grasp-os-connect" },
          // The outside systems connect reaches, so tests can plan how
          // they answer and read what they did (test/mail-server.ts).
          serviceBindings: { CONNECT_PROVIDERS: "connect-providers" },
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
              bindings: {
                CAPABILITY_SIGNING_KEY: capabilitySigningKey,
                TOKEN_ENCRYPTION_KEY: btoa("test-token-key-of-exactly-32-b!!"),
                MICROSOFT_CLIENT_ID: connectClient.id,
                MICROSOFT_CLIENT_SECRET: connectClient.secret,
              },
              d1Databases: { DB: "grasp-os-connect" },
              queueProducers: { AUDIT_QUEUE: "grasp-os-audit" },
              // Entra, as connect reaches it (test/connect-providers.ts).
              outboundService: "connect-providers",
            },
            {
              name: "connect-providers",
              modules: true,
              script: connectProvidersScript,
              compatibilityDate: "2026-09-15",
            },
          ],
        },
      })),
    ],
  });

export default coreProject({ exclude: [...defaultExclude, ...screenTests] });
