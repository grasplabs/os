import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CAPABILITY_SIGNING_KEY:
            "test-capability-signing-key-of-32-chars-or-more",
        },
      },
    }),
  ],
});
