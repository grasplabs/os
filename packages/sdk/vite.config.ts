import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vite-plus";

// The SDK runs inside workerd (workflow runs, and `describeWorkflow` when core
// saves a workflow), so its tests run there too, without Node compatibility.
export default defineProject({
  plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-09-15" } })],
});
