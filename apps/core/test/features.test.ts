import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { openRpc, outcome, signedInWithRole } from "./sign-in.ts";

// Features ship switched off, and switching one off is its kill switch:
// every call of its API is refused, whoever makes it.

const idp = mockIdp();

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
    outcome(session.decisions.get(crypto.randomUUID())),
    outcome(session.screens.version("app")),
    outcome(session.members.list()),
    outcome(session.audit.verify()),
    outcome(session.approvals.list()),
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
        "feature.disabled",
        "feature.disabled",
        "ok",
      ]);
    }
  });

  it("stop workflow parameter values with the workflows flag, whatever the approvals flag says", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const valuesWith = async (features: Record<string, boolean>) => {
      const coreEnv: Env = { ...env, FEATURES: features };
      const { core } = await openRpc(admin.session, { coreEnv });
      const { params } = core.authenticate().workflows;
      return await Promise.all([
        outcome(params.list("app", "workflow")),
        outcome(params.set("app", "workflow", "limit", 1)),
      ]);
    };
    await expect(
      Promise.all([
        valuesWith({ approvals: true }),
        valuesWith({ workflows: true }),
      ])
    ).resolves.toStrictEqual([
      ["feature.disabled", "feature.disabled"],
      // Past the flag: this App doesn't exist.
      ["app.not_found", "app.not_found"],
    ]);
  });

  it("keep permission grants needing an approval with the approvals flag off", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const coreEnv: Env = {
      ...env,
      FEATURES: { apps: true, permissions: true },
    };
    const { core } = await openRpc(admin.session, { coreEnv });
    const session = core.authenticate();
    const { id: appId } = await session.apps.create({ name: "Flagged" });
    const { id } = await session.permissions.request({
      subject: { type: "app", appId },
      object: { type: "connection", connectionId: "connection-outlook" },
      actions: ["mail.list"],
      binding: "OUTLOOK",
    });
    await expect(outcome(session.permissions.grant(id))).resolves.toBe(
      "approval.self"
    );
  });

  it("stop decisions with the workflows kill switch, whose runs they belong to", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const coreEnv: Env = { ...env, FEATURES: { decisions: true } };
    const { core } = await openRpc(admin.session, { coreEnv });
    const { decisions } = core.authenticate();
    await expect(
      Promise.all([
        outcome(decisions.get("decision")),
        outcome(decisions.answer("decision", { approved: true })),
      ])
    ).resolves.toStrictEqual(["feature.disabled", "feature.disabled"]);
  });
});
