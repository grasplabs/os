import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

const migrations = await readD1Migrations(
  `${import.meta.dirname}/src/db/migrations`
);

export default defineProject({
  test: {
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
          CONNECT_MIGRATIONS: migrations,
        },
      },
    }),
  ],
});
