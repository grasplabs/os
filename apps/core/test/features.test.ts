import { featureErrors } from "@grasp-os/shared/errors";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { openRpc, signedInWithRole } from "./sign-in.ts";

// Features ship switched off, and switching one off is its kill switch:
// every call of its API is refused, whoever makes it.

const idp = mockIdp();

/** The code a promise was refused with, or "ok" if it wasn't. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return featureErrors.codeOf(error) ?? String(error);
  }
};

/** What an admin gets from each flagged API with `features` as the flags. */
const callsWith = async (features?: unknown) => {
  const admin = await signedInWithRole(idp, "admin");
  const coreEnv: Env = { ...env, FEATURES: features };
  const { core } = await openRpc(admin.session, { coreEnv });
  const session = core.authenticate();
  return await Promise.all([
    outcome(session.apps.list()),
    outcome(session.permissions.list()),
    outcome(session.knowledge.listCollections()),
    outcome(session.connections.list()),
    outcome(session.workflows.list(crypto.randomUUID())),
    outcome(session.screens.version("app")),
    outcome(session.members.list()),
    outcome(session.audit.verify()),
    outcome(session.whoami()),
  ]);
};

describe("feature flags", () => {
  it("refuse every flagged API while no flag is set", async () => {
    await expect(callsWith()).resolves.toStrictEqual([
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "ok",
    ]);
  });

  it("switch on only the features they name as true", async () => {
    await expect(
      callsWith({ apps: true, permissions: false, unknown: true })
    ).resolves.toStrictEqual([
      "ok",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "ok",
    ]);
  });

  it("stop screens with the Apps kill switch, which run Apps", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const coreEnv: Env = { ...env, FEATURES: { apps: false, screens: true } };
    const { core } = await openRpc(admin.session, { coreEnv });
    const { screens } = core.authenticate();
    const at = { version: 1, screen: "desk" };
    const problem = { kind: "error", message: "x" } as const;
    await expect(
      Promise.all([
        outcome(screens.open("app", "desk")),
        outcome(screens.call("app", "label", [])),
        outcome(screens.version("app")),
        outcome(screens.report("app", at, problem)),
        outcome(screens.errors("app")),
      ])
    ).resolves.toStrictEqual(
      Array.from({ length: 5 }, () => "feature.disabled")
    );
  });

  it("switch everything off when the var doesn't parse", async () => {
    for (const features of ["{not json", '{"apps": "yes"}', "[true]"]) {
      // oxlint-disable-next-line no-await-in-loop -- one config at a time
      await expect(callsWith(features)).resolves.toStrictEqual([
        "feature.disabled",
        "feature.disabled",
        "feature.disabled",
        "feature.disabled",
        "feature.disabled",
        "feature.disabled",
        "feature.disabled",
        "feature.disabled",
        "ok",
      ]);
    }
  });
});
