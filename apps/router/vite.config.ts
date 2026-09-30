import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

import { coreStandInScript } from "./test/core-stand-in.ts";

export default defineProject({
  // Fails the suite when it isn't running in workerd.
  test: { setupFiles: ["../../scripts/assert-workerd.ts"] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // The router's real `fetch` reaches this Worker instead of the
        // internet, so tests can go through it end to end
        // (test/core-stand-in.ts).
        outboundService: "core-stand-in",
        workers: [
          {
            name: "core-stand-in",
            modules: true,
            script: coreStandInScript,
            compatibilityDate: "2026-09-15",
          },
        ],
      },
    }),
  ],
});
