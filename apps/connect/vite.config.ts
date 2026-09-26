import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

import { testConnectorsFile } from "./test/global-setup.ts";

const migrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/migrations`
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
          MICROSOFT_CLIENT_ID: "grasp-connect-entra",
          MICROSOFT_CLIENT_SECRET: "entra-connect-secret",
          GOOGLE_CLIENT_ID: "grasp-connect-google",
          GOOGLE_CLIENT_SECRET: "google-connect-secret",
          CONNECT_MIGRATIONS: migrations,
        },
      },
    }),
  ],
});
