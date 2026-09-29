import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { noteListedSkills } from "../src/knowledge/tools.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { actingFor } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam, readCollection, storedGrant } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// What a chat's agent reads before each question, and what its answer is
// labelled with. These tests start from the ways it can fail: the agent
// works without the company's rules or the skills it may use; its person's
// USER.md reaches it stale, or is saved from a chat that read restricted
// data; memory re-sent on every turn when nothing changed; and an answer
// built on sensitive data that nobody can tell apart.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** The system prompt of each request the model got, as its JSON. */
const systemOf = (body: unknown): string =>
  JSON.stringify(
    typeof body === "object" && body !== null && "system" in body
      ? body.system
      : null
  );

/**
 * More collections than one statement of a chat's SQLite could take a row
 * each of (its bound on values), each holding one document at `path`,
 * everyone's to read, and the agent `agentId`'s too.
 */
const manyReadable = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  agentId: string,
  path: string,
  text: (index: number) => string
): Promise<string[]> =>
  await Promise.all(
    Array.from({ length: 40 }, async (_, index) => {
      const { id } = await admin.api.knowledge.createCollection({
        name: `Team ${index} ${unique()}`,
        access: "everyone",
      });
      await admin.api.knowledge.saveDocument({
        collectionId: id,
        path,
        text: text(index),
        ifVersion: 0,
      });
      await storedGrant(
        { type: "agent", id: agentId },
        { type: "collection", id },
        ["read"],
        `TEAM_${index}`
      );
      return id;
    })
  );

/** Saves `text` at `path` in `collectionId`, over what is there now. */
const saveOver = async (
  person: Awaited<ReturnType<typeof signedInApi>>,
  collectionId: string,
  path: string,
  text: string
) => {
  const { documents } = await person.api.knowledge.listDocuments(collectionId);
  const current = documents.find((document) => document.path === path);
  return await person.api.knowledge.saveDocument({
    collectionId,
    path,
    text,
    ifVersion: current?.currentVersion ?? 0,
  });
};

describe("a chat's instructions and memory", setUpTime, () => {
  it("give the agent the company's rules, the skills it may read and how to build, and keep the person's USER.md current", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const rule = `Always answer in Dutch ${unique()}.`;
    const { memory } = await admin.api.memory.collections();
    if (memory === null) {
      throw new Error("An admin gets the Memory collection");
    }
    await saveOver(admin, memory, "AGENTS.md", `# Rules\n\n${rule}`);
    const { id: skills } = await admin.api.knowledge.createCollection({
      name: `Skills ${unique()}`,
      access: "everyone",
    });
    const skill = await admin.api.knowledge.saveDocument({
      collectionId: skills,
      path: "invoices/SKILL.md",
      text: "---\nname: book-invoices\ndescription: How we book invoices.\n---\n# Steps",
      ifVersion: 0,
    });
    const { stub, chat, gateway, ask, agent } = await chatOf(
      person.userId,
      codeStep(
        "export default async (env) => await env.memory.saveUser({ text: 'Prefers short answers.', ifVersion: 0 });"
      ),
      says("Noted."),
      says("Kort."),
      says("Nog steeds kort.")
    );
    await requestGranted(idp, admin, readCollection(agent, skills, "SKILLS"));

    await ask("Keep your answers short.");
    await ask("Hoe gaat het?");
    await ask("En nu?");

    const [first, , third, fourth] = gateway.requests.map(({ body }) =>
      systemOf(body)
    );
    expect({
      saved: await codeResults(stub, chat.id),
      first: [
        first?.includes(rule),
        first?.includes(`book-invoices (${skill.id}): How we book invoices.`),
        first?.includes("search the Apps collection"),
        first?.includes("Prefers short answers."),
      ],
      // The turn after the save has the new USER.md, and its version.
      third: [
        third?.includes("Prefers short answers."),
        third?.includes("USER.md (at version 1)"),
        third?.includes(rule),
      ],
      // Nothing changed since: the same prompt as the turn before.
      unchanged: fourth === third,
    }).toStrictEqual({
      saved: [{ isError: false, text: 'Returned:\n{"version":1}' }],
      first: [true, true, true, false],
      third: [true, true, true],
      unchanged: true,
    });
  });

  it("carry the collections whose skills the prompt lists as the chat's sources, and only those", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const [withSkill, withoutSkill] = await Promise.all(
      ["Skills", "Notes"].map(
        async (name) =>
          await admin.api.knowledge.createCollection({
            name: `${name} ${unique()}`,
            access: "everyone",
          })
      )
    );
    if (withSkill === undefined || withoutSkill === undefined) {
      throw new Error("Two collections");
    }
    const skill = await admin.api.knowledge.saveDocument({
      collectionId: withSkill.id,
      path: "invoices/SKILL.md",
      text: "---\nname: book-invoices\ndescription: How we book invoices.\n---\n# Steps",
      ifVersion: 0,
    });
    await admin.api.knowledge.saveDocument({
      collectionId: withoutSkill.id,
      path: "note.md",
      text: "# A note",
      ifVersion: 0,
    });
    const { ask, agent, chat } = await chatOf(person.userId, says("Hi."));
    await requestGranted(
      idp,
      admin,
      readCollection(agent, withSkill.id, "SKILLS")
    );
    await requestGranted(
      idp,
      admin,
      readCollection(agent, withoutSkill.id, "NOTES")
    );

    const answer = await ask("Hi.");

    // Listed: a read of the skill's collection, recorded as one.
    const [read] = await vi.waitFor(
      async () => {
        const events = await allEvents();
        const found = events.filter(
          ({ action, actor, detail }) =>
            action === "knowledge.read" &&
            actor.type === "agent" &&
            actor.agentId === agent.agentId &&
            detail.read === "skills"
        );
        expect(found).toHaveLength(1);
        return found;
      },
      { timeout: 10_000, interval: 50 }
    );
    expect({
      sources: {
        skills: answer.provenance.sources.includes(withSkill.id),
        notes: answer.provenance.sources.includes(withoutSkill.id),
      },
      read: {
        provenance: read?.provenance,
        detail: read?.detail,
      },
    }).toStrictEqual({
      sources: { skills: true, notes: false },
      read: {
        provenance: [withSkill.id, skill.id],
        detail: { read: "skills", skills: 1, sensitive: false, chat: chat.id },
      },
    });
  });

  it("restrict the chat before listing a skill of a sensitive collection", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const teamId = await newTeam(admin, [person]);
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Payroll ${unique()}`,
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const skill = await admin.api.knowledge.saveDocument({
      collectionId,
      path: "pay/SKILL.md",
      text: "---\nname: run-payroll\ndescription: How we run payroll.\n---\n# Steps",
      ifVersion: 0,
    });
    const { stub, agent, chat, id: workspaceId } = await chatOf(person.userId);
    const authority = actingFor(agent, person.userId);
    const context = { type: "chat", workspaceId, chatId: chat.id } as const;

    // The catalog never lists a sensitive collection's skills; were one
    // listed, the read that lists it restricts the chat first.
    const provenance = await noteListedSkills(
      env,
      { type: "delegate", authority, context },
      [
        {
          documentId: documentIdSchema.parse(skill.id),
          collectionId: collectionIdSchema.parse(collectionId),
          name: "run-payroll",
          description: "How we run payroll.",
        },
      ]
    );

    expect({
      provenance,
      restricted: await stub.isChatRestricted(chat.id),
    }).toStrictEqual({
      provenance: {
        collectionIds: [collectionId],
        sensitive: true,
        restricted: true,
      },
      restricted: true,
    });
  });

  it("record the catalog each turn reads for its skills, once a turn", async () => {
    const person = await signedInApi(idp, "user");
    const { ask, agent, chat } = await chatOf(
      person.userId,
      says("Hi."),
      says("Hi again.")
    );

    await ask("Hi.");
    await ask("Hi again.");

    const turns = await vi.waitFor(
      async () => {
        const events = await allEvents();
        const found = events.filter(
          ({ action, actor, detail }) =>
            action === "agent.call" &&
            actor.type === "agent" &&
            actor.agentId === agent.agentId &&
            detail.turn === true
        );
        expect(found).toHaveLength(2);
        return found;
      },
      { timeout: 10_000, interval: 50 }
    );
    expect(turns.map(({ detail }) => detail)).toStrictEqual(
      Array.from({ length: 2 }, () => ({
        method: "knowledge.catalog",
        collections: 0,
        skills: 0,
        turn: true,
        chat: chat.id,
        outcome: "ok",
        reason: null,
      }))
    );
  });

  it("label each answer with what the chat read, and whether it read restricted data", async () => {
    const person = await signedInApi(idp, "user");
    const { stub, chat, ask } = await chatOf(
      person.userId,
      says("Hi."),
      codeStep(
        "export default async (env) => { try { await env.memory.saveUser({ text: 'Earns a lot.', ifVersion: 0 }); return 'saved'; } catch (error) { return error.message; } };"
      ),
      says("Can't.")
    );

    const plain = await ask("Hi.");
    await stub.restrictChat(chat.id);
    const restricted = await ask("Remember my salary.");

    const results = await codeResults(stub, chat.id);
    expect({
      plain: plain.provenance.restricted,
      restricted: restricted.provenance.restricted,
      saved: results.map(({ text }) => text),
    }).toStrictEqual({
      plain: false,
      restricted: true,
      saved: [
        `Returned:\n${permissionErrors.create("permission.restricted").message}`,
      ],
    });
  });

  it("carry every skill's collection a turn lists, however many at once", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const { ask, agent } = await chatOf(person.userId, says("Hi."));
    const collections = await manyReadable(
      admin,
      agent.agentId,
      "howto/SKILL.md",
      (index) =>
        `---\nname: howto-${index}\ndescription: How team ${index} works.\n---\n# Steps`
    );

    const answer = await ask("Hi.");

    expect(
      collections.every((id) => answer.provenance.sources.includes(id))
    ).toBeTruthy();
  });

  it("carry every collection one read finds, however many at once", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInApi(idp, "user");
    const marker = `plover${unique()}`;
    const { ask, agent, stub, chat } = await chatOf(
      person.userId,
      codeStep(
        `export default async (env) => (await env.knowledge.search(${JSON.stringify(marker)}, { limit: 50 })).hits.length;`
      ),
      says("Found them.")
    );
    // Notes, not skills: the turn lists none, and the search finds them all.
    const collections = await manyReadable(
      admin,
      agent.agentId,
      "note.md",
      () => `# ${marker}`
    );

    const answer = await ask(`Where is ${marker}?`);

    expect({
      ran: await codeResults(stub, chat.id),
      carried: collections.every((id) =>
        answer.provenance.sources.includes(id)
      ),
    }).toStrictEqual({
      ran: [{ isError: false, text: "Returned:\n40" }],
      carried: true,
    });
  });
});
