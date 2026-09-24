import { defineConfig, devices } from "@playwright/test";

const port = 4173;
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
  webServer: {
    command: `vp -C apps/web dev --port ${port} --strictPort`,
    port,
    reuseExistingServer: !ci,
  },
});
