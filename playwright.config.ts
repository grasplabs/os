import { defineConfig, devices } from "@playwright/test";

const port = 8787;
const ci = process.env.CI === "true";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  reporter: ci ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The full local stack: core serves the built frontend, as in production.
  // `--local` keeps remote bindings off, so it runs without Cloudflare
  // credentials.
  webServer: {
    command: `vp run --filter @grasp-os/core dev --local --port ${port}`,
    port,
    reuseExistingServer: !ci,
    timeout: 120_000,
  },
});
