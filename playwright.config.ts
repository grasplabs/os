import { defineConfig, devices } from "@playwright/test";

import { testAuthSecret, testSignIn } from "./e2e/people.ts";

const port = 8787;
const ci = process.env.CI === "true";

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
  // Two workers, locally as in CI. Tests share core's local D1 file with
  // the dev server, and each sign-in write (e2e/people.ts) opens it from a
  // process of its own, which can make the dev server's queries fail
  // meanwhile. More workers overlap more often; two costs a little speed.
  workers: 2,
  reporter: ci ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // The full local stack: core serves the built frontend, as in production.
  // `--local` keeps remote bindings off, so it runs without Cloudflare
  // credentials. Sign-in is set up without an IdP, so tests can make
  // sessions themselves (e2e/people.ts), and the flagged features are on.
  webServer: {
    command: [
      `vp run --filter @grasp-os/core dev --local --port ${port}`,
      devVar("BETTER_AUTH_SECRET", testAuthSecret),
      devVar("SIGN_IN", JSON.stringify(testSignIn)),
      devVar(
        "FEATURES",
        JSON.stringify({
          apps: true,
          screens: true,
          members: true,
          workflows: true,
          decisions: true,
        })
      ),
    ].join(" "),
    port,
    reuseExistingServer: !ci,
    timeout: 120_000,
  },
});
