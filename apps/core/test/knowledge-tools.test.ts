import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { followMaxEntries } from "@grasp-os/shared/knowledge";
import type { KnowledgeApi, KnowledgeTools } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { catalogMaxCharacters } from "../src/knowledge/tools.ts";
import type { WorkContext } from "../src/restricted.ts";
import { workspace } from "../src/workspace.ts";
import { requestGranted } from "./apps.ts";
import {
  actingFor,
  collectionIn,
  envOf,
  knowledgeIn,
  newChat,
} from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, newTeam, readCollection } from "./knowledge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// The agent's Knowledge tools (`KNOWLEDGE` in its env, across every
// collection it may read) and the same reads for people and Apps. These
// tests start from the ways they can fail: an agent reads a whole long
// document to find one section; the catalog grows past what fits in an
// agent's context, or carries restricted data into it unrestricted; the
// tools reach a collection the agent wasn't granted or its person can't
// read (R5, R11); and a read, by anyone, leaves no trace in the audit log,
// or leaves its content there (R16).

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const personOf = async (role: Role) => {
  const person = await signedInApi(idp, role);
  const knowledge: KnowledgeApi = person.api.knowledge;
  return { ...person, knowledge };
};

type Person = Awaited<ReturnType<typeof personOf>>;

const newAgent = () => ({
  type: "agent" as const,
  agentId: `agent-${unique()}`,
});

/** The Knowledge tools of `agent` acting for `person`, in `context`. */
const toolsOf = async (
  agent: ReturnType<typeof newAgent>,
  person: Person,
  context?: WorkContext
): Promise<KnowledgeTools> => {
  const tools = knowledgeIn(
    await envOf(actingFor(agent, person.userId), context)
  );
  if (!tools) {
    throw new Error("No KNOWLEDGE binding");
  }
  return tools;
};

/** Saves `text` at `path` in a collection; returns the document's ID. */
const save = async (
  person: Person,
  collectionId: string,
  path: string,
  text: string
): Promise<string> => {
  const { id } = await person.knowledge.saveDocument({
    collectionId,
    path,
    text,
    ifVersion: 0,
  });
  return id;
};

/** A skill's text, as the Agent Skills format has it. */
const skill = (name: string, description: string, body = "# Steps") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

/** How each read of one document by `knowledge` ends. */
const documentReads = async (knowledge: KnowledgeTools, noteId: string) =>
  await Promise.all([
    outcome(knowledge.read(noteId)),
    outcome(knowledge.read(noteId, { section: 0 })),
    outcome(knowledge.follow(noteId)),
  ]);

/** The collections `knowledge` lists in its catalog, and finds "note" in. */
const collectionsOf = async (knowledge: KnowledgeTools) => {
  const [catalog, found] = await Promise.all([
    knowledge.catalog(),
    knowledge.search("note"),
  ]);
  return {
    catalog: catalog.collections.map(({ id }) => id).toSorted(),
    found: [
      ...new Set(found.hits.map(({ collectionId }) => collectionId)),
    ].toSorted(),
  };
};

const leave = "## Parental leave\nZwangerschapsverlof lasts sixteen weeks.";

/** A handbook of 42 sections, one of them about parental leave. */
const longHandbook = [
  "# Handbook",
  "Welcome.",
  ...Array.from({ length: 40 }, (_, index) =>
    index === 27
      ? leave
      : `## Topic ${index}\n${"Ordinary filler about the office. ".repeat(20)}`
  ),
].join("\n\n");

describe("an agent's Knowledge tools", setUpTime, () => {
  it("find one section of a long document and read it, without the rest", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    const documentId = await save(
      admin,
      collectionId,
      "handbook.md",
      longHandbook
    );
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    const knowledge = await toolsOf(agent, admin);

    const { hits } = await knowledge.search("zwangerschapsverlof");
    const [hit] = hits;
    if (!hit) {
      throw new Error("Nothing found");
    }
    const section = await knowledge.read(hit.documentId, {
      section: hit.section,
    });
    const whole = await knowledge.read(documentId);
    expect({
      hit: { documentId: hit.documentId, section: hit.section },
      section: {
        section: section.section,
        text: section.text,
        title: section.title,
      },
      whole: { section: whole.section, text: whole.text },
      refused: await Promise.all([
        outcome(knowledge.read(documentId, { section: 42 })),
        outcome(knowledge.read(documentId, { section: -1 })),
        outcome(
          knowledge.read(documentId, {
            // @ts-expect-error -- not an option
            heading: "Parental leave",
          })
        ),
        outcome(knowledge.read("no-such-document", { section: 0 })),
      ]),
    }).toStrictEqual({
      hit: { documentId, section: 28 },
      section: {
        section: { position: 28, headings: ["Handbook", "Parental leave"] },
        text: leave,
        title: "Handbook",
      },
      whole: { section: null, text: longHandbook },
      refused: [
        "knowledge.not_found",
        "knowledge.invalid",
        "knowledge.invalid",
        "knowledge.not_found",
      ],
    });
  });

  it("search for one type of document only", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const word = `kwartaal${unique().replaceAll(/\d/gu, "")}`;
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Reports ${unique()}`,
      access: "everyone",
    });
    const skillId = await save(
      admin,
      collectionId,
      "report/SKILL.md",
      skill("quarterly-report", `Writes the ${word} report.`)
    );
    const notesId = await save(
      admin,
      collectionId,
      "notes.md",
      `# Notes\nThe ${word} numbers.`
    );
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    const knowledge = await toolsOf(agent, admin);
    const handbook = collectionIn(
      await envOf(actingFor(agent, admin.userId)),
      "HANDBOOK"
    );
    const found = async (type?: "skill" | "doc") => {
      const { hits } = await knowledge.search(word, { type });
      return hits.map((hit) => `${hit.type} ${hit.documentId}`).toSorted();
    };
    // A collection's stub takes the type too.
    const inCollection = await handbook?.search(word, { type: "skill" });
    expect({
      any: await found(),
      skills: await found("skill"),
      docs: await found("doc"),
      inCollection: inCollection?.hits.map(({ documentId }) => documentId),
      unknownType: await outcome(
        // @ts-expect-error -- not a type of document
        knowledge.search(word, { type: "recipe" })
      ),
    }).toStrictEqual({
      any: [`doc ${notesId}`, `skill ${skillId}`],
      skills: [`skill ${skillId}`],
      docs: [`doc ${notesId}`],
      inCollection: [skillId],
      unknownType: "knowledge.invalid",
    });
  });

  it("follow a document's links and backlinks, and a skill to its files", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Skills ${unique()}`,
      access: "everyone",
    });
    const skillId = await save(
      admin,
      collectionId,
      "skills/report/SKILL.md",
      skill(
        "weekly-report",
        "Writes the weekly report.",
        "# Weekly report\nFill in [[skills/report/template.md]], see [[missing]]."
      )
    );
    const templateId = await save(
      admin,
      collectionId,
      "skills/report/template.md",
      "# Template\nNumbers go here."
    );
    const scriptId = await save(
      admin,
      collectionId,
      "skills/report/scripts/run.md",
      "# Run\nSteps."
    );
    // Next to the skill's folder, with names that start the same: not its.
    await save(admin, collectionId, "skills/report-old/a.md", "# Old");
    await save(admin, collectionId, "skills/reporting/b.md", "# Reporting");
    const otherId = await save(
      admin,
      collectionId,
      "other.md",
      "# Other\nUse [[skills/report/SKILL.md|the report skill]]."
    );
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    const knowledge = await toolsOf(agent, admin);

    const followed = await knowledge.follow(skillId);
    const template = await knowledge.follow(templateId);
    expect({
      skill: {
        links: followed.links,
        backlinks: followed.backlinks,
        files: followed.files.map(({ documentId, path, title, type }) => ({
          documentId,
          path,
          title,
          type,
        })),
        truncated: followed.truncated,
        provenance: followed.provenance,
      },
      template: {
        backlinks: template.backlinks.map(({ documentId }) => documentId),
        files: template.files,
      },
    }).toStrictEqual({
      skill: {
        links: [
          { path: "missing.md", label: null, documentId: null, title: null },
          {
            path: "skills/report/template.md",
            label: null,
            documentId: templateId,
            title: "Template",
          },
        ],
        backlinks: [
          {
            documentId: otherId,
            collectionId,
            path: "other.md",
            title: "Other",
            label: "the report skill",
          },
        ],
        files: [
          {
            documentId: scriptId,
            path: "skills/report/scripts/run.md",
            title: "Run",
            type: "doc",
          },
          {
            documentId: templateId,
            path: "skills/report/template.md",
            title: "Template",
            type: "doc",
          },
        ],
        truncated: false,
        provenance: {
          collectionIds: [collectionId],
          sensitive: false,
          restricted: false,
        },
      },
      // Not a skill: no files.
      template: { backlinks: [skillId], files: [] },
    });
  });

  it("say when a skill has more files than a follow returns", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Big skill ${unique()}`,
      access: "everyone",
    });
    const skillId = await save(
      admin,
      collectionId,
      "big/SKILL.md",
      skill("big", "Has many files.")
    );
    // As many files as a follow returns, in path order.
    const paths = Array.from(
      { length: followMaxEntries },
      (_, index) => `big/file-${String(index).padStart(3, "0")}.md`
    );
    await Promise.all(
      paths.map(async (path) => await save(admin, collectionId, path, "# File"))
    );
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    const knowledge = await toolsOf(agent, admin);
    const full = await knowledge.follow(skillId);
    // One more than it returns.
    await save(admin, collectionId, "big/zz-last.md", "# Last");
    const over = await knowledge.follow(skillId);
    expect({
      full: {
        files: full.files.map(({ path }) => path),
        truncated: full.truncated,
      },
      over: {
        files: over.files.map(({ path }) => path),
        truncated: over.truncated,
      },
    }).toStrictEqual({
      full: { files: paths, truncated: false },
      over: { files: paths, truncated: true },
    });
  });

  it("say when a document has more backlinks than a follow returns", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Popular ${unique()}`,
      access: "everyone",
    });
    const targetId = await save(admin, collectionId, "target.md", "# Target");
    // As many documents linking to it as a follow returns, in path order.
    const paths = Array.from(
      { length: followMaxEntries },
      (_, index) => `linking-${String(index).padStart(3, "0")}.md`
    );
    await Promise.all(
      paths.map(
        async (path) =>
          await save(admin, collectionId, path, "# Linking\nSee [[target]].")
      )
    );
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    const knowledge = await toolsOf(agent, admin);
    const full = await knowledge.follow(targetId);
    // One more than it returns.
    await save(admin, collectionId, "zz-last.md", "# Last\nSee [[target]].");
    const over = await knowledge.follow(targetId);
    expect({
      full: {
        backlinks: full.backlinks.map(({ path }) => path),
        truncated: full.truncated,
      },
      over: {
        backlinks: over.backlinks.map(({ path }) => path),
        truncated: over.truncated,
      },
    }).toStrictEqual({
      full: { backlinks: paths, truncated: false },
      over: { backlinks: paths, truncated: true },
    });
  });

  it("list the collections and skills they may read in a small catalog, without restricting their chat", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const teamId = await newTeam(admin, []);
    const [handbook, payroll, hidden] = await Promise.all([
      admin.knowledge.createCollection({
        name: `Handbook ${unique()}`,
        description: "Policies and how we work.",
        access: "everyone",
      }),
      admin.knowledge.createCollection({
        name: `Payroll ${unique()}`,
        description: "Salaries.",
        access: "teams",
        teams: [teamId],
        sensitive: true,
      }),
      admin.knowledge.createCollection({
        name: `Hidden ${unique()}`,
        access: "everyone",
      }),
    ]);
    const onboardingId = await save(
      admin,
      handbook.id,
      "onboarding/SKILL.md",
      skill("onboarding", "Welcomes a new colleague.")
    );
    await save(
      admin,
      payroll.id,
      "run/SKILL.md",
      skill("payroll-run", "Runs payroll for Jan de Vries.")
    );
    await save(
      admin,
      hidden.id,
      "hidden/SKILL.md",
      skill("hidden", "Not granted.")
    );
    await requestGranted(idp, admin, readCollection(agent, handbook.id));
    await requestGranted(
      idp,
      admin,
      readCollection(agent, payroll.id, "PAYROLL")
    );
    const chat = await newChat();
    const knowledge = await toolsOf(agent, admin, chat);

    const catalog = await knowledge.catalog();
    const personal = await admin.knowledge.catalog();
    expect({
      catalog,
      // A skill of a sensitive collection is restricted data: it stays out,
      // so the catalog restricts nothing; search finds it, and restricts.
      restricted: await workspace(env, chat.workspaceId).isChatRestricted(
        chat.chatId
      ),
      // A person's catalog has every collection they may read.
      personal: personal.collections.some(({ id }) => id === hidden.id),
    }).toStrictEqual({
      catalog: {
        collections: [
          {
            id: handbook.id,
            name: handbook.name,
            description: "Policies and how we work.",
            sensitive: false,
          },
          {
            id: payroll.id,
            name: payroll.name,
            description: "Salaries.",
            sensitive: true,
          },
        ],
        skills: [
          {
            documentId: onboardingId,
            collectionId: handbook.id,
            name: "onboarding",
            description: "Welcomes a new colleague.",
          },
        ],
        truncated: false,
      },
      restricted: false,
      personal: true,
    });
  });

  it("keep the catalog within its budget, however large the library", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Library ${unique()}`,
      description: "d".repeat(1024),
      access: "everyone",
    });
    const skills = 80;
    await Promise.all(
      Array.from(
        { length: skills },
        async (_, index) =>
          await save(
            admin,
            collectionId,
            `skill-${index}/SKILL.md`,
            skill(`skill-${index}`, "e".repeat(1024))
          )
      )
    );
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    const knowledge = await toolsOf(agent, admin);
    const catalog = await knowledge.catalog();
    const descriptions = [...catalog.collections, ...catalog.skills].map(
      ({ description }) => description.length
    );
    expect({
      size: JSON.stringify(catalog).length <= catalogMaxCharacters,
      collections: catalog.collections.map(({ id }) => id),
      someSkills: catalog.skills.length > 0 && catalog.skills.length < skills,
      longestDescription: Math.max(...descriptions),
      truncated: catalog.truncated,
    }).toStrictEqual({
      size: true,
      // Collections come first: the way in stays, whatever else is cut.
      collections: [collectionId],
      someSkills: true,
      longestDescription: 200,
      truncated: true,
    });
  });

  it("read only granted collections, as far as their person may read them", async () => {
    const admin = await personOf("admin");
    const outsider = await personOf("user");
    const agent = newAgent();
    const teamId = await newTeam(admin, []);
    const [granted, team, other] = await Promise.all([
      collectionWithNote(admin, { name: "Granted", access: "everyone" }),
      collectionWithNote(admin, {
        name: "Team",
        access: "teams",
        teams: [teamId],
      }),
      collectionWithNote(admin, { name: "Other", access: "everyone" }),
    ]);
    // Without a permission to read, there are no tools at all.
    const before = await envOf(actingFor(agent, admin.userId));
    const permission = await requestGranted(
      idp,
      admin,
      readCollection(agent, granted.collectionId)
    );
    await requestGranted(
      idp,
      admin,
      readCollection(agent, team.collectionId, "TEAM")
    );
    const asAdmin = await toolsOf(agent, admin);
    const asOutsider = await toolsOf(agent, outsider);
    const ok = ["ok", "ok", "ok"];
    const notFound = Array.from({ length: 3 }, () => "knowledge.not_found");
    expect({
      before: Object.keys(before),
      admin: {
        collections: await collectionsOf(asAdmin),
        granted: await documentReads(asAdmin, granted.noteId),
        team: await documentReads(asAdmin, team.noteId),
        other: await documentReads(asAdmin, other.noteId),
      },
      // Granted the team's collection, acting for someone outside the team.
      outsider: {
        collections: await collectionsOf(asOutsider),
        team: await documentReads(asOutsider, team.noteId),
      },
    }).toStrictEqual({
      before: [],
      admin: {
        collections: {
          catalog: [granted.collectionId, team.collectionId].toSorted(),
          found: [granted.collectionId, team.collectionId].toSorted(),
        },
        granted: ok,
        team: ok,
        other: notFound,
      },
      outsider: {
        collections: {
          catalog: [granted.collectionId],
          found: [granted.collectionId],
        },
        team: notFound,
      },
    });

    // Revoked: the tools it holds stop reading that collection at once.
    await admin.api.permissions.revoke(permission);
    await expect(
      Promise.all([
        collectionsOf(asAdmin),
        documentReads(asAdmin, granted.noteId),
      ])
    ).resolves.toStrictEqual([
      { catalog: [team.collectionId], found: [team.collectionId] },
      notFound,
    ]);
  });

  it("put their chat in restricted mode on reading a sensitive collection", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const teamId = await newTeam(admin, []);
    const payroll = await collectionWithNote(admin, {
      name: "Payroll",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    await requestGranted(
      idp,
      admin,
      readCollection(agent, payroll.collectionId)
    );
    const reads = [
      async (knowledge: KnowledgeTools) =>
        await knowledge.read(payroll.noteId, { section: 0 }),
      async (knowledge: KnowledgeTools) =>
        await knowledge.follow(payroll.noteId),
      async (knowledge: KnowledgeTools) => await knowledge.search("note"),
    ];
    const results = await Promise.all(
      reads.map(async (read) => {
        const chat = await newChat();
        const { provenance } = await read(await toolsOf(agent, admin, chat));
        const restricted = await workspace(
          env,
          chat.workspaceId
        ).isChatRestricted(chat.chatId);
        return { restricted, provenance: provenance.restricted };
      })
    );
    expect(results).toStrictEqual(
      reads.map(() => ({ restricted: true, provenance: true }))
    );
  });

  it("read nothing while Knowledge is switched off", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const handbook = await collectionWithNote(admin, {
      name: "Handbook",
      access: "everyone",
    });
    await requestGranted(
      idp,
      admin,
      readCollection(agent, handbook.collectionId)
    );
    const knowledge = await toolsOf(agent, admin);
    const every = async () =>
      await Promise.all([
        outcome(knowledge.catalog()),
        outcome(knowledge.search("note")),
        outcome(knowledge.read(handbook.noteId)),
        outcome(knowledge.follow(handbook.noteId)),
      ]);
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    let whileOff: string[];
    try {
      env.FEATURES = { ...on, knowledge: false };
      whileOff = await every();
    } finally {
      env.FEATURES = features;
    }
    expect({ whileOff, backOn: await every() }).toStrictEqual({
      whileOff: Array.from({ length: 4 }, () => "feature.disabled"),
      backOn: ["ok", "ok", "ok", "ok"],
    });
  });
});

/** A Knowledge event as the tests compare it: all but its ID and time. */
const readOf = ({ actor, action, target, provenance, detail }: AuditEvent) => ({
  actor,
  action,
  target,
  provenance: provenance.toSorted(),
  detail,
});

describe("Knowledge reads in the audit log", setUpTime, () => {
  it("record every read, by an agent, an App, a person or staff, with provenance and no content", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const { id } = await admin.api.apps.create({ name: `App ${unique()}` });
    const app = { type: "app" as const, appId: appIdSchema.parse(id) };
    const handbook = await collectionWithNote(admin, {
      name: "Handbook",
      access: "everyone",
    });
    const { collectionId, noteId } = handbook;
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    await requestGranted(idp, admin, readCollection(app, collectionId));
    const knowledge = await toolsOf(agent, admin);
    const appReader = collectionIn(
      await envOf(actingFor(app, admin.userId), app),
      "HANDBOOK"
    );
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = staffCore.authenticate();
    const { userId: staffId } = await staff.whoami();

    let found: string[] = [];
    const events = await auditedDuring(async () => {
      // An agent, through its tools; a refused read isn't one.
      const { hits } = await knowledge.search("note");
      found = hits.map(({ documentId }) => documentId);
      await knowledge.read(noteId, { section: 0 });
      await knowledge.read(noteId);
      await knowledge.follow(noteId);
      await outcome(knowledge.read("no-such-document"));
      // An App, through its collection stub.
      await appReader?.read(noteId);
      // A person, through every read of theirs.
      await admin.knowledge.getDocument(noteId);
      await admin.knowledge.listDocuments(collectionId);
      await admin.knowledge.history(noteId);
      await admin.knowledge.backlinks(noteId);
      await admin.knowledge.follow(noteId);
      // Staff, reading a collection for everyone.
      await staff.knowledge.read(noteId);
    });
    const agentActor = {
      type: "agent",
      agentId: agent.agentId,
      onBehalfOf: admin.userId,
    };
    const person = { type: "person", userId: admin.userId };
    const note = { type: "document", id: noteId };
    const fromHandbook = [collectionId];
    const reads = events.filter(({ action }) => action.startsWith("knowledge"));
    const expected = [
      {
        actor: agentActor,
        action: "knowledge.search",
        target: undefined,
        // The collection it read from, and each document it returned.
        provenance: [collectionId, ...new Set(found)],
        detail: { terms: 1, hits: found.length, sensitive: false },
      },
      {
        actor: agentActor,
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: { read: "section", version: 1, section: 0, sensitive: false },
      },
      {
        actor: agentActor,
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: { read: "document", version: 1, sensitive: false },
      },
      {
        actor: agentActor,
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: {
          read: "follow",
          links: 2,
          backlinks: 1,
          files: 0,
          sensitive: false,
        },
      },
      {
        actor: { type: "app", appId: app.appId, part: "server" },
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: { read: "document", version: 1, sensitive: false },
      },
      {
        actor: person,
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: { read: "document", version: 1, sensitive: false },
      },
      {
        actor: person,
        action: "knowledge.read",
        target: { type: "collection", id: collectionId },
        provenance: fromHandbook,
        detail: { read: "documents", count: 2, sensitive: false },
      },
      {
        actor: person,
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: { read: "history", count: 1, sensitive: false },
      },
      {
        actor: person,
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: { read: "backlinks", count: 1, sensitive: false },
      },
      {
        actor: person,
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: {
          read: "follow",
          links: 2,
          backlinks: 1,
          files: 0,
          sensitive: false,
        },
      },
      {
        actor: { type: "staff", userId: staffId },
        action: "knowledge.read",
        target: note,
        provenance: fromHandbook,
        detail: { read: "document", version: 1, sensitive: false },
      },
    ];
    expect({
      found: found.includes(noteId),
      reads: reads.map(readOf),
      content: JSON.stringify(reads).match(/See |Back to|note\.md/gu),
    }).toStrictEqual({
      found: true,
      reads: expected.map((read) => ({
        ...read,
        provenance: read.provenance.toSorted((one, other) =>
          one.localeCompare(other)
        ),
      })),
      content: null,
    });
  });
});
