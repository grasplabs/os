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
          // The tenant's own SharePoint, as the fake Graph redirects to it
          // (test/graph-api.ts), and the sample provider's storage.
          DOWNLOAD_HOSTS: JSON.stringify([
            "example.sharepoint.com",
            "tenant.storage.test",
          ]),
          ...smokeBindings,
        },
      },
    }),
  ],
});
