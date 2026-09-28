import type { AuditEvent } from "@grasp-os/shared/audit";
import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  gatewayConfig,
  model,
  pointAtGateway,
  says,
} from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam, readCollection } from "./knowledge.ts";
import { outcome, signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// `env.knowledge` in a chat's code: the chat's agent reading Knowledge for
// its person. These tests start from the ways it can fail: the agent reads
// a collection it wasn't granted, or one its person can't read (R5); a
// read leaves no trace in the audit log; and what one turn read reaches a
// model in a later turn, or after a restart, that the client's rules
// forbid for it, because the chat forgot it had read it.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** An admin who creates collections and grants the agent its permissions. */
const newAdmin = async () => {
  const admin = await signedInApi(idp, "admin");
  return { ...admin, knowledge: admin.api.knowledge };
};

/** A member of the organization, whom no other test uses: the chat's person. */
const newPerson = async () => await signedInWithRole(idp, "user");

type Admin = Awaited<ReturnType<typeof newAdmin>>;

/** Grants `agent` reading `collectionId`, under `binding`. */
const grantRead = async (
  admin: Admin,
  agent: { type: "agent"; agentId: string },
  collectionId: string
) => {
  await requestGranted(
    idp,
    admin,
    readCollection(agent, collectionId, `C${unique()}`.toUpperCase())
  );
};

/** The audit events of the chat's agent, once `done` holds for them. */
const eventsOf = async (
  agentId: string,
  done: (events: AuditEvent[]) => boolean
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "agent" && actor.agentId === agentId
    );
  };
  await vi.waitFor(
    async () => {
      expect(done(await mine())).toBeTruthy();
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

const modelCalls = (events: AuditEvent[]) =>
  events.filter(({ action }) => action === "model.call");

const leave = "# Parental leave\n\nParental leave lasts sixteen weeks.";

describe("a chat's Knowledge", setUpTime, () => {
  it("answers a policy question from the document it read, and every read is recorded", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const { id: documentId } = await admin.knowledge.saveDocument({
      collectionId,
      path: "leave.md",
      text: leave,
      ifVersion: 0,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        "export default async (env) => { const { hits } = await env.knowledge.search('parental leave'); const doc = await env.knowledge.read(hits[0].documentId, { section: hits[0].section }); return { title: doc.title, path: doc.path, text: doc.text }; };"
      ),
      says("Sixteen weeks (Handbook, leave.md).")
    );
    await grantRead(admin, agent, collectionId);

    const reply = await ask("How long is parental leave?");

    expect(reply).toStrictEqual({
      outcome: "answered",
      answer: "Sixteen weeks (Handbook, leave.md).",
    });
    // The model read the API's declaration before it wrote the code.
    const declared = JSON.stringify(gateway.requests[0]?.body);
    await expect(codeResults(stub, chat.id)).resolves.toStrictEqual([
      {
        isError: false,
        text: `Returned:\n${JSON.stringify({
          title: "Parental leave",
          path: "leave.md",
          text: leave,
        })}`,
      },
    ]);
    expect([
      declared.includes("interface KnowledgeHit {"),
      declared.includes("knowledge: {"),
    ]).toStrictEqual([true, true]);
    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 2
    );
    // Both reads, as the chat's agent acting for its person, with where
    // they read from and never what; then the request after the read,
    // which names the collection it came from.
    expect({
      reads: events
        .filter(({ action }) => action.startsWith("knowledge."))
        .map(({ action, actor, target, provenance }) => ({
          action,
          actor,
          target,
          provenance,
        })),
      requests: modelCalls(events).map(({ provenance }) => provenance),
      content: JSON.stringify(events).includes("sixteen"),
    }).toStrictEqual({
      reads: [
        {
          action: "knowledge.search",
          actor: { ...agent, onBehalfOf: person.userId },
          target: undefined,
          provenance: [collectionId, documentId],
        },
        {
          action: "knowledge.read",
          actor: { ...agent, onBehalfOf: person.userId },
          target: { type: "document", id: documentId },
          provenance: [collectionId],
        },
      ],
      requests: [[], [collectionId]],
      content: false,
    });
  });

  it("can't read a collection the agent wasn't granted, or one its person can't read", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const teamId = await newTeam(admin, []);
    const [granted, notGranted, team] = await Promise.all([
      collectionWithNote(admin, { name: "Granted", access: "everyone" }),
      collectionWithNote(admin, { name: "Not granted", access: "everyone" }),
      // A team the chat's person isn't in.
      collectionWithNote(admin, {
        name: "Team",
        access: "teams",
        teams: [teamId],
      }),
    ]);
    const ids = [granted.noteId, notGranted.noteId, team.noteId];
    const { stub, chat, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        `export default async (env) => {
          const tried = async (read) => { try { await read(); return "ok"; } catch (error) { return error.message; } };
          const catalog = await env.knowledge.catalog();
          const found = await env.knowledge.search("note");
          const reads = [];
          for (const id of ${JSON.stringify(ids)}) {
            reads.push([await tried(() => env.knowledge.read(id)), await tried(() => env.knowledge.follow(id))]);
          }
          return {
            catalog: catalog.collections.map(({ id }) => id),
            found: [...new Set(found.hits.map(({ collectionId }) => collectionId))],
            reads,
          };
        };`
      ),
      says("Done.")
    );
    await grantRead(admin, agent, granted.collectionId);
    await grantRead(admin, agent, team.collectionId);

    await ask("What can you read?");

    const [result] = await codeResults(stub, chat.id);
    const notFound = knowledgeErrors.create("knowledge.not_found").message;
    expect(result?.text).toBe(
      `Returned:\n${JSON.stringify({
        catalog: [granted.collectionId],
        found: [granted.collectionId],
        reads: [
          ["ok", "ok"],
          [notFound, notFound],
          [notFound, notFound],
        ],
      })}`
    );
  });

  it("judges every later request by what the chat read, in later turns and after a restart", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const { collectionId, noteId } = await collectionWithNote(admin, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const { stub, chat, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        `export default async (env) => (await env.knowledge.read(${JSON.stringify(noteId)})).title;`
      ),
      says("Note."),
      says("Still here.")
    );
    await grantRead(admin, agent, collectionId);

    await ask("Read the note.");
    await ask("And now?");
    await evictDurableObject(stub);
    await pointAtGateway(stub, fakeGateway(says("After a restart.")));
    await stub.ask(chat.id, { text: "And now?", model });

    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 4
    );
    expect(
      modelCalls(events).map(({ provenance }) => provenance)
    ).toStrictEqual([[], [collectionId], [collectionId], [collectionId]]);
  });

  it("keeps a chat that read a sensitive collection to the models its data rule allows, in every later turn", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const teamId = await newTeam(admin, [person]);
    const payroll = await collectionWithNote(admin, {
      name: `Payroll ${unique()}`,
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        `export default async (env) => (await env.knowledge.read(${JSON.stringify(payroll.noteId)})).title;`
      ),
      says("Never sent.")
    );
    const euModel = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    await pointAtGateway(stub, gateway, {
      config: {
        gateway: gatewayConfig.gateway,
        models: [model, euModel],
        sensitive: { models: [euModel] },
      },
    });
    await grantRead(admin, agent, payroll.collectionId);

    // The read is sensitive: the request after it is refused, before it
    // is sent, and so is the next turn, by what the chat read.
    const first = await ask("Read the payroll note.");
    await expect(outcome(ask("And now?"))).resolves.toBe(
      "model.sensitive_data"
    );

    expect(first.outcome).toBe("failed");
    expect(gateway.requests).toHaveLength(1);
    const events = await eventsOf(
      agent.agentId,
      (all) =>
        all.filter(({ action }) => action === "model.refused").length === 2
    );
    expect(
      events
        .filter(({ action }) => action === "model.refused")
        .map(({ detail, provenance }) => ({
          because: detail.because,
          provenance,
        }))
    ).toStrictEqual([
      { because: "collection", provenance: [payroll.collectionId] },
      { because: "collection", provenance: [payroll.collectionId] },
    ]);
    await expect(stub.isChatRestricted(chat.id)).resolves.toBeTruthy();
  });

  it("reads in every chat of the workspace under one grant, each chat keeping its own sources", async () => {
    const admin = await newAdmin();
    const person = await newPerson();
    const { collectionId, noteId } = await collectionWithNote(admin, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const read = codeStep(
      `export default async (env) => (await env.knowledge.read(${JSON.stringify(noteId)})).title;`
    );
    const { stub, chat, ask, agent } = await chatOf(
      person.userId,
      read,
      says("Note."),
      says("Hi."),
      read,
      says("Note here too.")
    );
    const other = await stub.createChat("Other", person.userId);
    // Granted once, to the workspace's agent.
    await grantRead(admin, agent, collectionId);

    const first = await ask("Read the note.");
    // Another chat of the workspace hasn't read anything yet: its first
    // request carries nothing the first chat read.
    const hello = await stub.ask(other.id, { text: "Hi.", model });
    const second = await stub.ask(other.id, { text: "Read it.", model });

    expect({
      first: first.outcome,
      hello: hello.outcome,
      second: second.outcome,
      results: [
        ...(await codeResults(stub, chat.id)),
        ...(await codeResults(stub, other.id)),
      ].map(({ text }) => text),
    }).toStrictEqual({
      first: "answered",
      hello: "answered",
      second: "answered",
      results: ["Returned:\nNote", "Returned:\nNote"],
    });
    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 5
    );
    // Every request names its chat, and carries that chat's sources only.
    expect(
      modelCalls(events).map(({ detail, provenance }) => ({
        chat: detail.chat,
        provenance,
      }))
    ).toStrictEqual([
      { chat: chat.id, provenance: [] },
      { chat: chat.id, provenance: [collectionId] },
      { chat: other.id, provenance: [] },
      { chat: other.id, provenance: [] },
      { chat: other.id, provenance: [collectionId] },
    ]);
  });

  it("acts for no workspace whose ID isn't a plain identifier", async () => {
    const person = await newPerson();
    // What no workspace core names looks like: it would reach into
    // another agent's memory path.
    const stub = workspace(env, workspaceIdSchema.parse("../other"));
    const chat = await stub.createChat("Questions", person.userId);

    await expect(
      outcome(stub.ask(chat.id, { text: "Hi.", model }))
    ).resolves.not.toBe("ok");
    await expect(
      runInDurableObject(stub, (instance) => instance.messages(chat.id))
    ).resolves.toStrictEqual([]);
  });

  it("records nothing for a code run that isn't open", async () => {
    const person = await newPerson();
    const { stub, chat, ask, agent } = await chatOf(person.userId, says("Hi."));

    await expect(
      stub.recordSources(chat.id, crypto.randomUUID(), ["collection-1"])
    ).resolves.toBeFalsy();
    await ask("Hi.");

    const events = await eventsOf(
      agent.agentId,
      (all) => modelCalls(all).length === 1
    );
    expect(
      modelCalls(events).map(({ provenance }) => provenance)
    ).toStrictEqual([[]]);
  });
});
