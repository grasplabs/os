import type { Role } from "@grasp-os/shared";
import { connectErrors } from "@grasp-os/shared/connect";
import { internalErrors } from "@grasp-os/shared/errors";
import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type {
  CollectionInput,
  CollectionReader,
  KnowledgeApi,
} from "@grasp-os/shared/knowledge";
import {
  authoritySchema,
  permissionErrors,
} from "@grasp-os/shared/permissions";
import type {
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { bindingsFor } from "../src/bindings.ts";
import { appHost } from "../src/durable-objects.ts";
import type { WorkContext } from "../src/restricted.ts";
import { workspace } from "../src/workspace.ts";
import { collectionIn, connectionIn, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { callAuth, openRpc, signedInWithRole } from "./sign-in.ts";

// Knowledge as Apps and agents reach it, and restricted mode. These tests
// start from the ways it can fail: an App or agent reads what it has no
// permission for, or what the person it acts for can't read (R5); a listing,
// history or backlink shows something of a collection it can't read (R11);
// a read of sensitive data comes back unmarked (R12); and a chat or App
// that read restricted data still reaches outside systems, also after its
// object restarts (Q12).

const idp = mockIdp();

const unique = () => crypto.randomUUID().slice(0, 8);

/** A signed-in person's API, on a connection of their own. */
const personOf = async (role: Role) => {
  const person = await signedInWithRole(idp, role);
  const { core } = await openRpc(person.session);
  const api = core.authenticate();
  const knowledge: KnowledgeApi = api.knowledge;
  return { ...person, api, knowledge };
};

type Person = Awaited<ReturnType<typeof personOf>>;

const newAgent = (): PermissionSubjectInput => ({
  type: "agent",
  agentId: `agent-${unique()}`,
});

/** A team with `members`, made by an admin. */
const newTeam = async (admin: Person, members: Person[]): Promise<string> => {
  const created = await callAuth("/organization/create-team", admin.session, {
    name: `Team ${unique()}`,
  });
  const { id } = z.object({ id: z.string() }).parse(await created.json());
  for (const member of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await callAuth("/organization/add-team-member", admin.session, {
      teamId: id,
      userId: member.userId,
    });
  }
  return id;
};

/** A collection with one document, `note.md`, that links to itself. */
const collectionWithNote = async (owner: Person, input: CollectionInput) => {
  const collection = await owner.knowledge.createCollection(input);
  const note = await owner.knowledge.saveDocument({
    collectionId: collection.id,
    path: "note.md",
    text: "# Note\nSee [[note.md]] and [[other.md]].",
    ifVersion: 0,
  });
  await owner.knowledge.saveDocument({
    collectionId: collection.id,
    path: "other.md",
    text: "# Other\nBack to [[note.md]].",
    ifVersion: 0,
  });
  return { collectionId: collection.id, noteId: note.id };
};

/** Asks for and grants `request`; returns the permission's ID. */
const granted = async (admin: Person, request: PermissionRequest) => {
  const { id } = await admin.api.requestPermission(request);
  await admin.api.grantPermission(id);
  return id;
};

const readCollection = (
  subject: PermissionSubjectInput,
  collectionId: string,
  binding = "HANDBOOK"
): PermissionRequest => ({
  subject,
  object: { type: "collection", collectionId },
  actions: ["read"],
  binding,
});

const outlook = (subject: PermissionSubjectInput): PermissionRequest => ({
  subject,
  object: { type: "connection", connectionId: "connection-outlook" },
  actions: ["mail.list", "mail.send"],
  binding: "OUTLOOK",
});

/** The env an agent or App gets, acting for `userId` in `context`. */
const envOf = async (
  subject: PermissionSubjectInput,
  userId: string,
  context: WorkContext
) =>
  await bindingsFor(
    env,
    authoritySchema.parse({
      subject,
      onBehalfOf: userId,
      mode: "interactive",
    }),
    context
  );

type Env = Awaited<ReturnType<typeof envOf>>;

/** A collection's stub from an env, as App or agent code calls it. */
const readerIn = (bindings: Env, binding = "HANDBOOK"): CollectionReader => {
  const stub = collectionIn(bindings, binding);
  if (!stub) {
    throw new Error(`No ${binding} binding`);
  }
  return stub;
};

/** The code a promise was refused with, or "ok" if it wasn't. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (
      knowledgeErrors.codeOf(error) ??
      permissionErrors.codeOf(error) ??
      connectErrors.codeOf(error) ??
      internalErrors.codeOf(error) ??
      String(error)
    );
  }
};

/** Every read of a collection stub, on `noteId`. */
const everyRead = async (reader: CollectionReader, noteId: string) =>
  await Promise.all([
    outcome(reader.listDocuments()),
    outcome(reader.getDocument(noteId)),
    outcome(reader.getDocument(noteId, 1)),
    outcome(reader.history(noteId)),
    outcome(reader.backlinks(noteId)),
  ]);

/** A connection call, a fetch or a side effect, from an env. */
const callOutlook = async (bindings: Env, sideEffect = false) => {
  const stub = connectionIn(bindings, "OUTLOOK");
  if (!stub) {
    throw new Error("No OUTLOOK binding");
  }
  return await outcome(
    sideEffect
      ? stub.call(
          "mail.send",
          { to: "x@elsewhere.test" },
          {
            idempotencyKey: unique(),
          }
        )
      : stub.call("mail.list", {})
  );
};

/** Reached through connect: the call passed every check core makes. */
const reached = "connect.connection_not_found";

describe("Apps and agents reading Knowledge", () => {
  it("read no collection without a granted permission to read it", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const context = await newChat();
    const handbook = await collectionWithNote(admin, {
      name: "Handbook",
      access: "everyone",
    });
    const other = await collectionWithNote(admin, {
      name: "Other",
      access: "everyone",
    });

    // Nothing granted, only requested, or only to write: no way to read.
    const before = await envOf(agent, admin.userId, context);
    const { id: permissionId } = await admin.api.requestPermission(
      readCollection(agent, handbook.collectionId)
    );
    const whileRequested = await envOf(agent, admin.userId, context);
    await granted(admin, {
      ...readCollection(agent, handbook.collectionId, "HANDBOOK_WRITE"),
      actions: ["write"],
    });
    const writeOnly = readerIn(
      await envOf(agent, admin.userId, context),
      "HANDBOOK_WRITE"
    );
    expect({
      before: Object.keys(before),
      whileRequested: Object.keys(whileRequested),
      writeOnly: await everyRead(writeOnly, handbook.noteId),
    }).toStrictEqual({
      before: [],
      whileRequested: [],
      writeOnly: Array.from({ length: 5 }, () => "permission.denied"),
    });

    // Granted one collection: that one, and no document of another.
    await admin.api.grantPermission(permissionId);
    const reader = readerIn(await envOf(agent, admin.userId, context));
    expect({
      own: await everyRead(reader, handbook.noteId),
      other: await everyRead(reader, other.noteId),
    }).toStrictEqual({
      own: ["ok", "ok", "ok", "ok", "ok"],
      other: ["ok", ...Array.from({ length: 4 }, () => "knowledge.not_found")],
    });
    const listed = await reader.listDocuments();
    expect(
      listed.documents.every(
        ({ collectionId }) => collectionId === handbook.collectionId
      )
    ).toBeTruthy();

    // Revoked: the stub it holds stops at its next call.
    await admin.api.revokePermission(permissionId);
    await expect(everyRead(reader, handbook.noteId)).resolves.toStrictEqual(
      Array.from({ length: 5 }, () => "permission.denied")
    );
  });

  it("read only what the person they act for may read too", async () => {
    const admin = await personOf("admin");
    const member = await personOf("user");
    const outsider = await personOf("user");
    const teamId = await newTeam(admin, [member]);
    const finance = await collectionWithNote(admin, {
      name: "Finance",
      access: "teams",
      teams: [teamId],
    });
    const diary = await collectionWithNote(member, {
      name: "Diary",
      access: "me",
    });
    const agent = newAgent();
    await granted(admin, readCollection(agent, finance.collectionId));
    await granted(admin, readCollection(agent, diary.collectionId, "DIARY"));

    const readsAs = async (person: Person) => {
      const bindings = await envOf(agent, person.userId, await newChat());
      return {
        finance: await everyRead(readerIn(bindings), finance.noteId),
        diary: await everyRead(readerIn(bindings, "DIARY"), diary.noteId),
      };
    };
    const allOk = ["ok", "ok", "ok", "ok", "ok"];
    const noneFound = Array.from({ length: 5 }, () => "knowledge.not_found");
    expect({
      member: await readsAs(member),
      outsider: await readsAs(outsider),
    }).toStrictEqual({
      member: { finance: allOk, diary: allOk },
      // The grant alone isn't enough: an agent granted a collection, acting
      // for someone who can't see it, reads nothing of it.
      outsider: { finance: noneFound, diary: noneFound },
    });
  });

  it("show no titles or paths of documents they can't read", async () => {
    const admin = await personOf("admin");
    const outsider = await personOf("user");
    const teamId = await newTeam(admin, []);
    const secret = await collectionWithNote(admin, {
      name: "Board",
      access: "teams",
      teams: [teamId],
    });
    const agent = newAgent();
    await granted(admin, readCollection(agent, secret.collectionId));
    const reader = readerIn(
      await envOf(agent, outsider.userId, await newChat())
    );

    const refused = await Promise.all([
      outcome(reader.listDocuments()),
      outcome(reader.history(secret.noteId)),
      outcome(reader.backlinks(secret.noteId)),
    ]);
    expect(refused).toStrictEqual([
      "knowledge.not_found",
      "knowledge.not_found",
      "knowledge.not_found",
    ]);
  });
});

/** The provenance of each of `reads`. */
const provenanceOf = async (
  reads: Promise<{ provenance: unknown }>[]
): Promise<unknown[]> => {
  const results = await Promise.all(reads);
  return results.map(({ provenance }) => provenance);
};

/** Every read of a collection stub, on `noteId`, for its provenance. */
const stubReads = (reader: CollectionReader, noteId: string) => [
  reader.listDocuments(),
  reader.getDocument(noteId),
  reader.history(noteId),
  reader.backlinks(noteId),
];

/** Four reads' provenance: all from `collectionId`. */
const marked = (collectionId: string, isSensitive: boolean) =>
  Array.from({ length: 4 }, () => ({
    collectionIds: [collectionId],
    sensitive: isSensitive,
    restricted: isSensitive,
  }));

describe("provenance", () => {
  it("names the collection of every read, and marks sensitive ones", async () => {
    const admin = await personOf("admin");
    const teamId = await newTeam(admin, []);
    const sensitive = await collectionWithNote(admin, {
      name: "Payroll",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const ordinary = await collectionWithNote(admin, {
      name: "Handbook",
      access: "everyone",
    });
    const agent = newAgent();
    await granted(admin, readCollection(agent, sensitive.collectionId));
    await granted(admin, readCollection(agent, ordinary.collectionId, "OTHER"));
    const bindings = await envOf(agent, admin.userId, await newChat());

    const byPerson = admin.knowledge;
    const personReads = ({ collectionId, noteId }: typeof sensitive) => [
      byPerson.listDocuments(collectionId),
      byPerson.getDocument(noteId),
      byPerson.history(noteId),
      byPerson.backlinks(noteId),
    ];
    expect({
      personSensitive: await provenanceOf(personReads(sensitive)),
      personOrdinary: await provenanceOf(personReads(ordinary)),
      agentSensitive: await provenanceOf(
        stubReads(readerIn(bindings), sensitive.noteId)
      ),
      agentOrdinary: await provenanceOf(
        stubReads(readerIn(bindings, "OTHER"), ordinary.noteId)
      ),
    }).toStrictEqual({
      personSensitive: marked(sensitive.collectionId, true),
      personOrdinary: marked(ordinary.collectionId, false),
      agentSensitive: marked(sensitive.collectionId, true),
      agentOrdinary: marked(ordinary.collectionId, false),
    });
  });
});

describe("restricted mode", () => {
  /** An agent that may read a sensitive and an ordinary collection, and use Outlook. */
  const setUp = async (subject: PermissionSubjectInput = newAgent()) => {
    const admin = await personOf("admin");
    const teamId = await newTeam(admin, []);
    const sensitive = await collectionWithNote(admin, {
      name: "Payroll",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const ordinary = await collectionWithNote(admin, {
      name: "Handbook",
      access: "everyone",
    });
    await granted(admin, readCollection(subject, sensitive.collectionId));
    await granted(
      admin,
      readCollection(subject, ordinary.collectionId, "OTHER")
    );
    await granted(admin, outlook(subject));
    return { admin, subject, sensitive, ordinary };
  };

  it("stops a chat's outside calls for good once it read restricted data", async () => {
    const { admin, subject, sensitive, ordinary } = await setUp();
    const chat = await newChat();
    const otherChat = await newChat();
    const bindings = await envOf(subject, admin.userId, chat);

    // Reading ordinary Knowledge changes nothing.
    await readerIn(bindings, "OTHER").getDocument(ordinary.noteId);
    const beforeRestricted = await Promise.all([
      callOutlook(bindings),
      callOutlook(bindings, true),
    ]);
    await readerIn(bindings).getDocument(sensitive.noteId);
    const afterRestricted = await Promise.all([
      callOutlook(bindings),
      callOutlook(bindings, true),
      // Knowledge stays inside the deployment, so it can still be read.
      outcome(readerIn(bindings, "OTHER").getDocument(ordinary.noteId)),
    ]);
    expect({ beforeRestricted, afterRestricted }).toStrictEqual({
      beforeRestricted: [reached, reached],
      afterRestricted: ["permission.restricted", "permission.restricted", "ok"],
    });

    // Its workspace restarts, and the chat gets a new env: still restricted.
    await evictDurableObject(workspace(env, chat.workspaceId));
    const rebuilt = await envOf(subject, admin.userId, chat);
    const other = await envOf(subject, admin.userId, otherChat);
    expect({
      restarted: await Promise.all([
        callOutlook(rebuilt),
        callOutlook(rebuilt, true),
      ]),
      // Another chat is its own: it read nothing restricted.
      otherChat: await callOutlook(other),
    }).toStrictEqual({
      restarted: ["permission.restricted", "permission.restricted"],
      otherChat: reached,
    });
  });

  it("is entered by listings, history and backlinks too", async () => {
    const { admin, subject, sensitive } = await setUp();
    const reads = [
      async (reader: CollectionReader) => await reader.listDocuments(),
      async (reader: CollectionReader) =>
        await reader.history(sensitive.noteId),
      async (reader: CollectionReader) =>
        await reader.backlinks(sensitive.noteId),
    ];
    const results = await Promise.all(
      reads.map(async (read) => {
        const bindings = await envOf(subject, admin.userId, await newChat());
        await read(readerIn(bindings));
        return await callOutlook(bindings);
      })
    );
    expect(results).toStrictEqual([
      "permission.restricted",
      "permission.restricted",
      "permission.restricted",
    ]);
  });

  it("isn't entered by a read that was refused", async () => {
    const { subject, sensitive } = await setUp();
    const outsider = await personOf("user");
    const bindings = await envOf(subject, outsider.userId, await newChat());
    // The permission covers Outlook for the outsider too; Payroll isn't theirs.
    const refused = await outcome(
      readerIn(bindings).getDocument(sensitive.noteId)
    );
    expect({ refused, call: await callOutlook(bindings) }).toStrictEqual({
      refused: "knowledge.not_found",
      call: reached,
    });
  });

  it("stops an App's outside calls for good once it read restricted data", async () => {
    const creator = await personOf("admin");
    const { id } = await creator.api.apps.create({ name: `App ${unique()}` });
    const appId = appIdSchema.parse(id);
    const { admin, subject, sensitive } = await setUp({ type: "app", appId });
    const context: WorkContext = { type: "app", appId };
    const bindings = await envOf(subject, admin.userId, context);

    const before = await callOutlook(bindings);
    await readerIn(bindings).getDocument(sensitive.noteId);
    await evictDurableObject(appHost(env, appId));
    const after = await callOutlook(
      await envOf(subject, admin.userId, context)
    );
    expect({ before, after }).toStrictEqual({
      before: reached,
      after: "permission.restricted",
    });
  });

  it("keeps a chat that doesn't exist from reading or calling out", async () => {
    const { admin, subject, sensitive } = await setUp();
    const missing: WorkContext = {
      type: "chat",
      workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
      chatId: chatIdSchema.parse(crypto.randomUUID()),
    };
    const bindings = await envOf(subject, admin.userId, missing);
    // Nowhere to keep restricted mode, so nothing that would need it runs.
    await expect(
      Promise.all([
        callOutlook(bindings),
        outcome(readerIn(bindings).getDocument(sensitive.noteId)),
      ])
    ).resolves.toStrictEqual(["internal.unexpected", "internal.unexpected"]);
  });
});
