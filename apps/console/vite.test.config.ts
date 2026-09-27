import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineProject } from "vite-plus";

import { accessTeam } from "./test/access-config.ts";

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
        },
      },
    }),
  ],
});
