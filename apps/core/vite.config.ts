import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

import { testSignIn } from "./test/sign-in-config.ts";

const coreMigrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/core/migrations`
);

export default defineProject({
  test: {
    // Core bundles the screen compiler from its build output.
    globalSetup: ["../../packages/compiler/build.ts"],
    // Brings the core database up to the committed migrations.
    setupFiles: ["./test/apply-migrations.ts"],
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
          ...testSignIn,
          // workerd doesn't implement Durable Object jurisdictions.
          DURABLE_OBJECT_JURISDICTION: "none",
          CORE_MIGRATIONS: coreMigrations,
        },
        // Deliver audit events at once instead of waiting to fill a batch.
        queueConsumers: { "grasp-os-audit": { maxBatchTimeout: 0 } },
        // A stand-in frontend, so tests don't wait for a build of apps/web.
        assets: { directory: "./test/fixtures/assets" },
        // Stand-in for the connect Worker behind the CONNECT service binding.
        workers: [
          {
            name: "grasp-os-connect",
            modules: true,
            compatibilityDate: "2026-09-15",
            script:
              "export default { fetch: () => new Response(null, { status: 404 }) };",
          },
        ],
      },
    }),
  ],
});
