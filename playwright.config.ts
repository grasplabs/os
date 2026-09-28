import { defineConfig, devices } from "@playwright/test";

import { localIdpPort, localSignIn } from "./apps/core/test/sign-in-config.ts";
import { origin, testAuthSecret } from "./e2e/people.ts";

const port = 8787;
const ci = process.env.CI === "true";

/** The one model the stack's gateway allows; no test calls it. */
const e2eModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** A `--var` for wrangler dev, quoted once for the shell. */
const devVar = (name: string, value: string): string =>
  `--var '${name}:${value}'`;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  // Must cover a test's longest waits one after another. The decision
  // test's are the longest (e2e/decisions.e2e.ts): up to 30 s for the ask,
  // 15 s for each of three page loads and the answer, then 30 s for the
  // run to end: 2 minutes, before its clicks and sign-ins.
  timeout: 180_000,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  // Two workers, locally as in CI: one local dev server serves every test,
  // and more at once slow it past the tests' waits (pages, live updates).
  workers: 2,
  globalSetup: "./e2e/setup.ts",
  reporter: ci ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    // The full local stack: core serves the built frontend, as in
    // production. `--local` keeps remote bindings off, so it runs without
    // Cloudflare credentials. People sign in through the fake IdP below
    // (e2e/people.ts), and the flagged features are on.
    {
      command: [
        `vp run --filter @grasp-os/core dev --local --port ${port}`,
        devVar("BETTER_AUTH_SECRET", testAuthSecret),
        ...Object.entries(localSignIn(origin)).map(([name, value]) =>
          devVar(
            name,
            typeof value === "string" ? value : JSON.stringify(value)
          )
        ),
        devVar(
          "FEATURES",
          JSON.stringify({
            apps: true,
            app_sharing: true,
            app_blueprints: true,
            builtins: true,
            playbook: true,
            screens: true,
            screen_workflows: true,
            members: true,
            workflows: true,
            decisions: true,
            connections: true,
            permissions: true,
            knowledge: true,
            memory: true,
            knowledge_uploads: true,
            model_rules: true,
            model_settings: true,
          })
        ),
        // `--local` has no Workers AI: a deployment kept in the EU extracts
        // uploads' text in the Worker instead (knowledge/extract.ts). No
        // test calls a model; the Models page shows the rules and budgets.
        devVar(
          "MODEL_GATEWAY",
          JSON.stringify({
            gateway: "grasp-os-e2e",
            models: [e2eModel],
            eu: { models: [e2eModel], deployment: true },
            budgets: { deployment: { limit: 250 }, user: { limit: 20 } },
          })
        ),
      ].join(" "),
      port,
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
    // Stands in for the client's Entra tenant.
    {
      command: `node_modules/.bin/wrangler dev -c apps/core/test/idp.wrangler.jsonc --port ${localIdpPort}`,
      port: localIdpPort,
      reuseExistingServer: !ci,
      timeout: 60_000,
    },
  ],
});
