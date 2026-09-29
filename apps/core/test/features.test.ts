import { uploadOriginalPath } from "@grasp-os/shared/uploads";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { openRpc, outcome, routed, signedInWithRole } from "./sign-in.ts";

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
    outcome(session.memory.collections()),
    outcome(session.knowledgeSignals.list()),
    outcome(session.uploads.get(crypto.randomUUID())),
    outcome(session.connections.list()),
    outcome(session.workflows.list(crypto.randomUUID())),
    outcome(session.decisions.get(crypto.randomUUID())),
    outcome(session.screens.version("app")),
    outcome(session.members.list()),
    outcome(session.audit.verify()),
    outcome(session.models.settings()),
    outcome(session.pendingActions.list()),
    outcome(session.signals.list()),
    outcome(session.chats.list()),
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
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "feature.disabled",
      "ok",
    ]);
  });

  it("stop uploads with their own flag, and with the Knowledge kill switch", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const uploadsWith = async (features: Record<string, boolean>) => {
      const coreEnv: Env = { ...env, FEATURES: features };
      const { core } = await openRpc(admin.session, { coreEnv });
      const { uploads } = core.authenticate();
      const original = await routed(
        uploadOriginalPath(crypto.randomUUID()),
        {},
        coreEnv
      );
      return [
        await outcome(uploads.get(crypto.randomUUID())),
        await outcome(
          uploads.upload({
            collectionId: crypto.randomUUID(),
            name: "a.pdf",
            bytes: new Uint8Array(0),
          })
        ),
        // Signed out: past the flags, a download needs a session.
        original.status,
      ];
    };
    await expect(
      Promise.all([
        uploadsWith({ knowledge: true }),
        uploadsWith({ knowledge_uploads: true }),
        uploadsWith({ knowledge: true, knowledge_uploads: true }),
      ])
    ).resolves.toStrictEqual([
      ["feature.disabled", "feature.disabled", 404],
      ["feature.disabled", "feature.disabled", 404],
      ["upload.not_found", "upload.unsupported", 401],
    ]);
  });

  it("stop Knowledge usage signals with their own flag, and with the Knowledge kill switch", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const signalsWith = async (features: Record<string, boolean>) => {
      const coreEnv: Env = { ...env, FEATURES: features };
      const { core } = await openRpc(admin.session, { coreEnv });
      const { knowledgeSignals } = core.authenticate();
      return await Promise.all([
        outcome(knowledgeSignals.list()),
        outcome(knowledgeSignals.dismiss(crypto.randomUUID())),
      ]);
    };
    await expect(
      Promise.all([
        signalsWith({ knowledge: true }),
        signalsWith({ knowledge_signals: true }),
        signalsWith({ knowledge: true, knowledge_signals: true }),
      ])
    ).resolves.toStrictEqual([
      ["feature.disabled", "feature.disabled"],
      ["feature.disabled", "feature.disabled"],
      // Past the flags: there's no such signal.
      ["ok", "knowledge_signal.not_found"],
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

  it("stop sharing Apps with its own flag, and with the Apps kill switch", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const sharingWith = async (features: Record<string, boolean>) => {
      const coreEnv: Env = { ...env, FEATURES: features };
      const { core } = await openRpc(admin.session, { coreEnv });
      const { members } = core.authenticate().apps;
      const member = { type: "team", id: "team" } as const;
      return await Promise.all([
        outcome(members.list("app")),
        outcome(members.add("app", { ...member, role: "user" })),
        outcome(members.remove("app", member)),
      ]);
    };
    await expect(
      Promise.all([
        sharingWith({ apps: true }),
        sharingWith({ app_sharing: true }),
        sharingWith({ apps: true, app_sharing: true }),
      ])
    ).resolves.toStrictEqual([
      Array.from({ length: 3 }, () => "feature.disabled"),
      Array.from({ length: 3 }, () => "feature.disabled"),
      // Past the flags: this App doesn't exist.
      Array.from({ length: 3 }, () => "app.not_found"),
    ]);
  });

  it("stop blueprints with their own flag, the Apps kill switch, and sharing's", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const blueprintsWith = async (features: Record<string, boolean>) => {
      const coreEnv: Env = { ...env, FEATURES: features };
      const { core } = await openRpc(admin.session, { coreEnv });
      const { blueprints } = core.authenticate().apps;
      return await Promise.all([
        outcome(blueprints.list()),
        outcome(blueprints.mark("app", 1)),
        outcome(blueprints.unmark("app", 1)),
        outcome(blueprints.create("app", 1, { name: "Mine" })),
      ]);
    };
    await expect(
      Promise.all([
        blueprintsWith({ apps: true, app_sharing: true }),
        blueprintsWith({ app_sharing: true, app_blueprints: true }),
        // Whose access is App roles, which sharing turns on.
        blueprintsWith({ apps: true, app_blueprints: true }),
        blueprintsWith({ apps: true, app_sharing: true, app_blueprints: true }),
      ])
    ).resolves.toStrictEqual([
      Array.from({ length: 4 }, () => "feature.disabled"),
      Array.from({ length: 4 }, () => "feature.disabled"),
      Array.from({ length: 4 }, () => "feature.disabled"),
      // Past the flags: this App doesn't exist.
      ["ok", "app.not_found", "app.not_found", "app.not_found"],
    ]);
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

  it("stop chats with their own flag, and with the agent kill switch", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const chatsWith = async (features: Record<string, boolean>) => {
      const coreEnv: Env = { ...env, FEATURES: features };
      const { core } = await openRpc(admin.session, { coreEnv });
      const { chats } = core.authenticate();
      return await Promise.all([
        outcome(chats.list()),
        outcome(chats.send("chat", { text: "Hi.", model: "any" })),
      ]);
    };
    await expect(
      Promise.all([
        chatsWith({ agent: true }),
        chatsWith({ chat: true }),
        chatsWith({ agent: true, chat: true }),
      ])
    ).resolves.toStrictEqual([
      ["feature.disabled", "feature.disabled"],
      ["feature.disabled", "feature.disabled"],
      // Past the flags: this chat doesn't exist.
      ["ok", "agent.chat_not_found"],
    ]);
  });

  it("stop workflow parameter values with the workflows flag", async () => {
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
        valuesWith({ apps: true, workflows: false }),
        valuesWith({ workflows: true }),
      ])
    ).resolves.toStrictEqual([
      ["feature.disabled", "feature.disabled"],
      // Past the flag: this App doesn't exist.
      ["app.not_found", "app.not_found"],
    ]);
  });

  it("stop held actions with either the connections or the confirmations flag", async () => {
    const admin = await signedInWithRole(idp, "admin");
    const callsWithFlags = async (features: Record<string, boolean>) => {
      const coreEnv: Env = { ...env, FEATURES: features };
      const { core } = await openRpc(admin.session, { coreEnv });
      const { pendingActions } = core.authenticate();
      const id = crypto.randomUUID();
      return await Promise.all([
        outcome(pendingActions.list()),
        outcome(pendingActions.confirm(id, "0".repeat(64))),
        outcome(pendingActions.decline(id)),
      ]);
    };
    await expect(
      Promise.all([
        callsWithFlags({ connections: true }),
        callsWithFlags({ confirmations: true }),
      ])
    ).resolves.toStrictEqual([
      Array.from({ length: 3 }, () => "feature.disabled"),
      Array.from({ length: 3 }, () => "feature.disabled"),
    ]);
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
