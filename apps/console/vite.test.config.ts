import { readdirSync, readFileSync } from "node:fs";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineProject } from "vite-plus";

import { accessTeam } from "./test/access-config.ts";

const migrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/migrations`
);

/**
 * Core's Knowledge migrations as their files hold them, for the test that
 * applies real migrations through the console's client (FTS5 tables,
 * triggers, comments).
 */
const knowledgeMigrationsDir = `${import.meta.dirname}/../core/src/db/knowledge/migrations`;
const knowledgeMigrationFiles = readdirSync(knowledgeMigrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .toSorted()
  .map((name) => ({
    name,
    sql: readFileSync(`${knowledgeMigrationsDir}/${name}`, "utf-8"),
  }));

/**
 * The console's tests, in workerd. The Cloudflare Vite plugin (vite.config.ts)
 * can't run as a Vitest project, so the test pool runs the Worker instead,
 * with TanStack Start's plugin for the modules its handler loads: the tests
 * go through the real entry (src/server.ts), app included.
 */
export default defineProject({
  test: {
    name: "console",
    include: ["test/**/*.test.ts"],
    // The first page a test file renders loads the whole app through Vite's
    // module runner, about 2 s on an idle machine and several times that on
    // a loaded one (CI, or the whole repo's suites at once), past Vitest's
    // 5 s default. A hang still fails, just later.
    testTimeout: 30_000,
    // The pool inlines every dependency, and the module runner loads each
    // module with its own round trip to Vite, one import after another.
    // lucide-react's entry re-exports about 1,850 icon modules, so a page
    // with an icon (the rollouts page's Selects) took several times as long
    // as the rest of the app: past 30 s under CI's load. Pre-bundled, it is
    // one module. React stays out of the bundle, so there is one React.
    deps: {
      optimizer: {
        ssr: { enabled: true, include: ["@grasp-os/ui > lucide-react"] },
      },
    },
    // Brings the database up to the committed migrations.
    setupFiles: ["./test/apply-migrations.ts"],
  },
  plugins: [
    tanstackStart(),
    react(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests run fully local, including in CI without Cloudflare credentials.
      remoteBindings: false,
      miniflare: {
        bindings: {
          // The Access team test/access.ts stands in for.
          CF_ACCESS_AUD: accessTeam.audience,
          CF_ACCESS_ISS: accessTeam.issuer,
          // Off whatever a developer's .dev.vars sets: the tests of the
          // bypass set it themselves.
          DEV_ACCESS_EMAIL: "",
          // Where provisioned clients are served (src/deploy/context.ts).
          CLIENT_DOMAIN: "grasp.test",
          // Where TanStack Start answers server functions: the build sets
          // it; here the Worker reads it from process.env, which workerd
          // fills from its vars, so tests can call them through the entry.
          TSS_SERVER_FN_BASE: "/_serverFn/",
          // Grasp's OAuth apps, which clients' sign-in names (src/deploy/core-config.ts).
          ENTRA_CLIENT_ID: "test-entra-app",
          GOOGLE_CLIENT_ID: "test-google-app.apps.googleusercontent.com",
          CONSOLE_MIGRATIONS: migrations,
          KNOWLEDGE_MIGRATION_FILES: knowledgeMigrationFiles,
        },
        // Where the fake Cloudflare API runs client D1 queries, one for
        // each database it holds at once (test/cloudflare-api-workers.ts).
        d1Databases: Object.fromEntries(
          Array.from({ length: 12 }, (_, slot) => [
            `CLIENT_D1_${slot}`,
            `client-d1-${slot}`,
          ])
        ),
      },
    }),
  ],
});
