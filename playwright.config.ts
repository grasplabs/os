import { defineConfig, devices } from "@playwright/test";

import { localSignIn } from "./apps/core/test/sign-in-config.ts";
import { testAuthSecret } from "./e2e/people.ts";
import { corePort, idpOrigin, idpPort, origin, stateDir } from "./e2e/stack.ts";

/** The end-to-end tests of the Playbook's built-ins (their own project). */
const playbookTests = /(?:board-page|intake|workflow-map)\.e2e\.ts$/u;
const ci = process.env.CI === "true";

/**
 * The one model the stack's gateway allows. `--local` reaches no AI Gateway,
 * so a call to it fails: the chat test (e2e/chat.e2e.ts) shows that failure.
 */
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
    baseURL: origin,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: playbookTests,
    },
    // The Playbook's built-ins: one copy of each has the Playbook's record
    // types (core's knowledge/record-types.ts), so their tests hand it from
    // copy to copy (e2e/playbook.ts), one test at a time.
    {
      name: "playbook",
      use: { ...devices["Desktop Chrome"] },
      testMatch: playbookTests,
      workers: 1,
    },
  ],
  // Never a server already running: on this checkout's ports (e2e/stack.ts)
  // that is a stale run or another checkout's stack, with state the tests
  // don't expect. Playwright then fails, naming the port.
  webServer: [
    // The full local stack: core serves the built frontend, as in
    // production. `--local` keeps remote bindings off, so it runs without
    // Cloudflare credentials. It starts from empty state, as in CI, kept
    // apart from `vp run dev`'s. This can't wait for the global setup,
    // which Playwright runs once the servers are up. People sign in through
    // the fake IdP below (e2e/people.ts).
    {
      command: [
        // The dir comes from `env` below, so no path is ever shell syntax.
        'rm -rf "$DEV_PERSIST_TO" &&',
        `vp run --filter @grasp-os/core dev --local --port ${corePort}`,
        devVar("BETTER_AUTH_SECRET", testAuthSecret),
        ...Object.entries(localSignIn(origin, idpOrigin)).map(([name, value]) =>
          devVar(
            name,
            typeof value === "string" ? value : JSON.stringify(value)
          )
        ),
        // `--local` has no Workers AI: a deployment kept in the EU extracts
        // uploads' text in the Worker instead (knowledge/extract.ts). The
        // Models page shows the rules and budgets.
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
      env: { DEV_PERSIST_TO: stateDir },
      port: corePort,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    // Stands in for the client's Entra tenant.
    {
      command: `node_modules/.bin/wrangler dev -c apps/core/test/idp.wrangler.jsonc --port ${idpPort}`,
      port: idpPort,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
