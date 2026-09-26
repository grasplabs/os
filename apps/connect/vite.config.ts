import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

import { testConnectorsFile } from "./test/global-setup.ts";
import { clients } from "./test/provider-config.ts";

const migrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/migrations`
);

/**
 * The live smoke tests' tenant and workspace (test/*.live.test.ts), passed
 * on only when set: without them, they are skipped.
 */
const smokeBindings = Object.fromEntries(
  [
    "M365_SMOKE_ACCESS_TOKEN",
    "M365_SMOKE_MAILBOX",
    "M365_SMOKE_DRIVE",
    "M365_SMOKE_WRITES",
    "M365_SMOKE_FOREIGN_FOLDER",
    "GOOGLE_SMOKE_ACCESS_TOKEN",
    "GOOGLE_SMOKE_MAILBOX",
    "GOOGLE_SMOKE_CALENDAR",
    "GOOGLE_SMOKE_DRIVE",
    "GOOGLE_SMOKE_WRITES",
  ].flatMap((name) => {
    const value = process.env[name];
    return value === undefined || value === "" ? [] : [[name, value]];
  })
);

/** Seals the tests' tokens: 32 bytes, in base64, as a real key is. */
const testTokenKey = btoa("test-token-key-of-exactly-32-b!!");

export default defineProject({
  // The tests' connectors: the release's and the sample one (see the setup).
  resolve: { alias: { "#connectors": testConnectorsFile } },
  test: {
    // Builds the connectors the tests load, once per run.
    globalSetup: ["./test/global-setup.ts"],
    // Brings the connect database up to the committed migrations.
    setupFiles: ["./test/apply-migrations.ts"],
    // Logs go straight to workerd's output, not to Vitest: one from another
    // request than the test's could leave the file waiting forever (see
    // core's vite.config.ts).
    disableConsoleIntercept: true,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests run fully local, including in CI without Cloudflare credentials.
      remoteBindings: false,
      miniflare: {
        bindings: {
          CAPABILITY_SIGNING_KEY:
            "test-capability-signing-key-of-32-chars-or-more",
          // As while rotating keys.
          CAPABILITY_SIGNING_KEY_PREVIOUS:
            "test-previous-signing-key-of-32-chars-or-more",
          TOKEN_ENCRYPTION_KEY: testTokenKey,
          // Grasp's OAuth apps, as test/oauth-provider.ts knows them.
          MICROSOFT_CLIENT_ID: clients.microsoft.id,
          MICROSOFT_CLIENT_SECRET: clients.microsoft.secret,
          GOOGLE_CLIENT_ID: clients.google.id,
          GOOGLE_CLIENT_SECRET: clients.google.secret,
          CONNECT_MIGRATIONS: migrations,
          // As a deployment of an earlier release may still have it: nothing
          // reads it, and downloads to other hosts go all the same.
          DOWNLOAD_HOSTS: JSON.stringify(["example.sharepoint.com"]),
          ...smokeBindings,
        },
      },
    }),
  ],
});
