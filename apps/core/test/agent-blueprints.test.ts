import { appErrors } from "@grasp-os/shared/apps";
import { roleErrors } from "@grasp-os/shared/roles";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { signedInApi } from "./sign-in.ts";

// `env.build.createFromBlueprint` in a chat's code: the chat's agent
// creating an App from a blueprint for its person. These tests start from
// the ways it can fail: the agent creates from a blueprint its person
// couldn't create from themselves (of an App they have no role in, or as
// someone who doesn't build), past the Apps a question may create, or
// while blueprints are off; and what it creates or asks for isn't recorded
// as the agent's.

const idp = mockIdp();

/** What a code step returned, as JSON. */
const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

/** Code that makes each call in turn: what it returned, or its message. */
const tryEach = (calls: Record<string, string>): string =>
  `export default async (env) => {
    const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
    const results = {};
    ${Object.entries(calls)
      .map(
        ([name, call]) =>
          `results[${JSON.stringify(name)}] = await tried(async () => ${call});`
      )
      .join("\n    ")}
    return results;
  };`;

/**
 * A chat of `role`'s person answered by `replies`, whose agent may build
 * Apps; the Ledger, a builder's App marked as a blueprint and shared with
 * the person, which reads a collection; and the Vault, a blueprint of
 * another builder's that the person has no role in.
 */
const setUp = async (
  replies: (apps: { ledger: string; vault: string }) => GatewayReply[],
  role: "builder" | "user" = "builder"
) => {
  const admin = await signedInApi(idp, "admin");
  const [owner, stranger] = await Promise.all([
    signedInApi(idp, "builder"),
    signedInApi(idp, "builder"),
  ]);
  const person = await signedInApi(idp, role);
  const { id: ledger } = await owner.api.apps.create({ name: "Ledger" });
  const version = await release(owner, ledger, {
    "screens/desk.tsx": "export default () => null;\n",
  });
  const { collectionId } = await collectionWithNote(admin.api, {
    name: "Handbook",
    access: "everyone",
  });
  await requestGranted(
    idp,
    admin,
    readCollection({ type: "app", appId: ledger }, collectionId)
  );
  await owner.api.apps.blueprints.mark(ledger, version);
  await owner.api.apps.members.add(ledger, {
    type: "person",
    id: person.userId,
    role: "user",
  });
  const { id: vault } = await stranger.api.apps.create({ name: "Vault" });
  await stranger.api.apps.blueprints.mark(
    vault,
    await release(stranger, vault, { "notes.md": "vault" })
  );
  const chat = await chatOf(person.userId, ...replies({ ledger, vault }));
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "collection", collectionId: "apps" },
    actions: ["read", "write"],
    binding: "APP_LIBRARY",
  });
  return { person, chat, ledger, vault };
};

describe(
  "creating Apps from blueprints from a chat",
  { timeout: 60_000 },
  () => {
    it("creates one as its person may, asking for what the blueprint declares, as the agent", async () => {
      const { person, chat, ledger } = await setUp(() => [
        codeStep(`export default async (env) => {
        const listed = await env.build.blueprints();
        const { app, version } = listed.find(({ name }) => name === "Ledger");
        const created = await env.build.createFromBlueprint(app, version, { name: "My ledger" });
        return {
          listed: listed.map(({ name, version }) => ({ name, version })),
          app: created.app.id,
          name: created.app.name,
          permissions: created.permissions.map(({ binding, status }) => ({ binding, status })),
        };
      };`),
        says("Your ledger is there."),
      ]);

      await chat.ask("Make me a ledger like the team's");

      const [result] = await codeResults(chat.stub, chat.chat.id);
      const made = z
        .object({ app: z.string() })
        .loose()
        .parse(returned(result?.text));
      expect(made).toStrictEqual({
        listed: [{ name: "Ledger", version: 1 }],
        app: made.app,
        name: "My ledger",
        permissions: [{ binding: "HANDBOOK", status: "requested" }],
      });
      const agent = {
        type: "agent",
        agentId: chat.agent.agentId,
        onBehalfOf: person.userId,
      };
      // The person's App, and what it asks for is asked by the agent for
      // them, both as the audit log and the request say.
      const listed = await person.api.apps.list();
      const app = listed.find(({ id }) => id === made.app);
      const requests = await person.api.permissions.list();
      const request = requests.find(
        ({ subject }) => subject.type === "app" && subject.appId === made.app
      );
      expect({ app, request }).toMatchObject({
        app: { owner: person.userId, blueprint: `${ledger}@1` },
        request: {
          requestedBy: person.userId,
          requestedVia: {
            ...agent,
            workspaceId: chat.id,
            chatId: chat.chat.id,
          },
        },
      });
      await vi.waitFor(
        async () => {
          const events = await allEvents();
          expect(
            [
              ["app.created", made.app],
              ["app.committed", made.app],
              ["permission.requested", request?.id],
            ].map(
              ([action, target]) =>
                events.find(
                  (event) =>
                    event.action === action && event.target?.id === target
                )?.actor
            )
          ).toStrictEqual([agent, agent, agent]);
        },
        { timeout: 10_000, interval: 50 }
      );
    });

    it("creates only from what its person may, within a question's creates", async () => {
      const attempts = ({ ledger, vault }: { ledger: string; vault: string }) =>
        codeStep(
          tryEach({
            vault: `(await env.build.createFromBlueprint(${JSON.stringify(vault)}, 1, { name: "Mine" })).app.name`,
            notMarked: `(await env.build.createFromBlueprint(${JSON.stringify(ledger)}, 2, { name: "Mine" })).app.name`,
            first: `(await env.build.create({ name: "One" })).name`,
            second: `(await env.build.create({ name: "Two" })).name`,
            third: `(await env.build.createFromBlueprint(${JSON.stringify(ledger)}, 1, { name: "Three" })).app.name`,
            fourth: `(await env.build.createFromBlueprint(${JSON.stringify(ledger)}, 1, { name: "Four" })).app.name`,
          })
        );
      // One chat at a time: a Workspace object's env points at the
      // gateway of the chat set up last.
      const builds = await setUp((apps) => [attempts(apps), says("Done.")]);
      await builds.chat.ask("Make the Apps");
      const uses = await setUp(
        ({ ledger }) => [
          codeStep(
            tryEach({
              listed: "(await env.build.blueprints()).length",
              create: `(await env.build.createFromBlueprint(${JSON.stringify(ledger)}, 1, { name: "Mine" })).app.name`,
            })
          ),
          says("No."),
        ],
        "user"
      );
      await uses.chat.ask("Make me a ledger");

      const results = await Promise.all(
        [builds, uses].map(async ({ chat }) => {
          const [result] = await codeResults(chat.stub, chat.chat.id);
          return returned(result?.text);
        })
      );
      expect(results).toStrictEqual([
        {
          // Of an App the person has no role in: as if there were none.
          vault: appErrors.create("app.not_found").message,
          notMarked: appErrors.create("app.blueprint_not_found").message,
          first: "One",
          second: "Two",
          third: "Three",
          fourth: appErrors.create("app.creates_exhausted").message,
        },
        {
          // Someone who uses Apps but doesn't build: their blueprints are
          // listed, and none is created.
          listed: 1,
          create: roleErrors.create("role.forbidden").message,
        },
      ]);
    });
  }
);
