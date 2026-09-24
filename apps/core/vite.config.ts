import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests run fully local, including in CI without Cloudflare credentials.
      remoteBindings: false,
      miniflare: {
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
