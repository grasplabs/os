import { permissionErrors } from "@grasp-os/shared/permissions";
import { describe, expect, it } from "vite-plus/test";

import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
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
});
