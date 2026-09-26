import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type {
  CollectionReader,
  KnowledgeApi,
} from "@grasp-os/shared/knowledge";
import { authoritySchema } from "@grasp-os/shared/permissions";
import type {
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { bindingsFor } from "../src/bindings.ts";
import { appHost } from "../src/durable-objects.ts";
import type { WorkContext } from "../src/restricted.ts";
import { workspace } from "../src/workspace.ts";
import { collectionIn, connectionIn, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  collectionWithNote,
  newTeam,
  readCollection,
  storedGrant,
} from "./knowledge.ts";
import { callAuth, outcome, signedInApi, unique } from "./sign-in.ts";

// Knowledge as Apps and agents reach it, and restricted mode. These tests
// start from the ways it can fail: an App or agent reads what it has no
// permission for, or what the person it acts for can't read (R5); a listing,
// history or backlink shows something of a collection it can't read (R11);
// a read of sensitive data comes back unmarked (R12); and a chat or App
// that read restricted data still reaches outside systems, also after its
// object restarts (Q12).

const idp = mockIdp();

/** A signed-in person's API, on a connection of their own. */
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

/** Asks for and grants `request`; returns the permission's ID. */
const granted = async (admin: Person, request: PermissionRequest) => {
  const { id } = await admin.api.permissions.request(request);
  await admin.api.permissions.grant(id);
  return id;
};

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

/**
 * Every read of a collection stub, on `noteId`. The stub's own collection
 * comes first and last: its listing and a search in it.
 */
const everyRead = async (reader: CollectionReader, noteId: string) =>
  await Promise.all([
    outcome(reader.listDocuments()),
    outcome(reader.getDocument(noteId)),
    outcome(reader.getDocument(noteId, 1)),
    outcome(reader.history(noteId)),
    outcome(reader.backlinks(noteId)),
    outcome(reader.search("note")),
  ]);

const everyReadIs = (code: string) => Array.from({ length: 6 }, () => code);

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
    const { id: permissionId } = await admin.api.permissions.request(
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
      writeOnly: everyReadIs("permission.denied"),
    });

    // Granted one collection: that one, and no document of another.
    await admin.api.permissions.grant(permissionId);
    const reader = readerIn(await envOf(agent, admin.userId, context));
    expect({
      own: await everyRead(reader, handbook.noteId),
      other: await everyRead(reader, other.noteId),
    }).toStrictEqual({
      own: everyReadIs("ok"),
      other: [
        "ok",
        ...Array.from({ length: 4 }, () => "knowledge.not_found"),
        "ok",
      ],
    });
    // Both collections have a `note.md`: only its own is listed or found.
    const listed = await reader.listDocuments();
    const found = await reader.search("note");
    expect({
      listed: listed.documents.map(({ collectionId }) => collectionId),
      found: found.hits.map(({ collectionId }) => collectionId),
    }).toStrictEqual({
      listed: [handbook.collectionId, handbook.collectionId],
      found: [handbook.collectionId, handbook.collectionId],
    });

    // Revoked: the stub it holds stops at its next call.
    await admin.api.permissions.revoke(permissionId);
    await expect(everyRead(reader, handbook.noteId)).resolves.toStrictEqual(
      everyReadIs("permission.denied")
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
    const agent = newAgent();
    await granted(admin, readCollection(agent, finance.collectionId));
    const readsAs = async (person: Person) =>
      await everyRead(
        readerIn(await envOf(agent, person.userId, await newChat())),
        finance.noteId
      );
    const allOk = everyReadIs("ok");
    const noneFound = everyReadIs("knowledge.not_found");
    expect({
      member: await readsAs(member),
      // The grant alone isn't enough: an agent granted a collection, acting
      // for someone who can't see it, reads nothing of it.
      outsider: await readsAs(outsider),
    }).toStrictEqual({ member: allOk, outsider: noneFound });

    // The member leaves the team while the agent holds its stub.
    const held = readerIn(await envOf(agent, member.userId, await newChat()));
    await callAuth("/organization/remove-team-member", admin.session, {
      teamId,
      userId: member.userId,
    });
    await expect(everyRead(held, finance.noteId)).resolves.toStrictEqual(
      noneFound
    );
  });

  it("never read a personal collection, not even their person's own", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("user");
    const diary = await collectionWithNote(owner, {
      name: "Diary",
      access: "me",
    });
    const agent = newAgent();
    const creator = await personOf("admin");
    const { id } = await creator.api.apps.create({ name: `App ${unique()}` });
    const app = { type: "app" as const, appId: appIdSchema.parse(id) };

    // Nobody can be asked to give one, nor one that doesn't exist.
    const requests = await Promise.all([
      outcome(
        admin.api.permissions.request(readCollection(agent, diary.collectionId))
      ),
      outcome(
        admin.api.permissions.request(
          readCollection(agent, "no-such-collection")
        )
      ),
    ]);
    // A grant that exists anyway reads nothing in a chat or an App, even
    // acting for the owner: both can be shared with others.
    await storedGrant(
      { type: "agent", id: agent.agentId },
      { type: "collection", id: diary.collectionId },
      ["read"],
      "DIARY"
    );
    await storedGrant(
      { type: "app", id: app.appId },
      { type: "collection", id: diary.collectionId },
      ["read"],
      "DIARY"
    );
    const inChat = readerIn(
      await envOf(agent, owner.userId, await newChat()),
      "DIARY"
    );
    const inApp = readerIn(
      await envOf(app, owner.userId, { type: "app", appId: app.appId }),
      "DIARY"
    );
    const noneFound = everyReadIs("knowledge.not_found");
    expect({
      requests,
      inChat: await everyRead(inChat, diary.noteId),
      inApp: await everyRead(inApp, diary.noteId),
    }).toStrictEqual({
      requests: ["permission.invalid", "permission.invalid"],
      inChat: noneFound,
      inApp: noneFound,
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
      outcome(reader.search("note")),
    ]);
    expect(refused).toStrictEqual([
      "knowledge.not_found",
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
  reader.search("note"),
];

/** Five reads' provenance: all from `collectionId`. */
const marked = (collectionId: string, isSensitive: boolean) =>
  Array.from({ length: 5 }, () => ({
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
      byPerson.search("note", { collectionId }),
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

  it("is entered by listings, history, backlinks and searches too", async () => {
    const { admin, subject, sensitive } = await setUp();
    const reads = [
      async (reader: CollectionReader) => await reader.listDocuments(),
      async (reader: CollectionReader) =>
        await reader.history(sensitive.noteId),
      async (reader: CollectionReader) =>
        await reader.backlinks(sensitive.noteId),
      async (reader: CollectionReader) => await reader.search("note"),
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
      "permission.restricted",
    ]);
  });

  it("isn't entered by a read that was refused, or a search that found nothing", async () => {
    const { admin, subject, sensitive } = await setUp();
    const outsider = await personOf("user");
    const bindings = await envOf(subject, outsider.userId, await newChat());
    // The permission covers Outlook for the outsider too; Payroll isn't theirs.
    const refused = await outcome(
      readerIn(bindings).getDocument(sensitive.noteId)
    );
    const searched = await envOf(subject, admin.userId, await newChat());
    const { hits, provenance } = await readerIn(searched).search(
      `nothing${unique()}`
    );
    expect({
      refused,
      call: await callOutlook(bindings),
      found: { hits, provenance },
      afterSearch: await callOutlook(searched),
    }).toStrictEqual({
      refused: "knowledge.not_found",
      call: reached,
      found: {
        hits: [],
        provenance: { collectionIds: [], sensitive: false, restricted: false },
      },
      afterSearch: reached,
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

  it("is kept only in a context that exists and is the App's own", async () => {
    const { admin, subject, sensitive } = await setUp();
    const creator = await personOf("admin");
    const appOf = async () => {
      const { id } = await creator.api.apps.create({ name: `App ${unique()}` });
      return appIdSchema.parse(id);
    };
    const [own, other] = await Promise.all([appOf(), appOf()]);
    const app = { type: "app" as const, appId: own };
    await granted(admin, outlook(app));
    await granted(admin, readCollection(app, sensitive.collectionId));
    const ghost = `app-${unique()}`;
    await storedGrant(
      { type: "app", id: ghost },
      { type: "connection", id: "connection-outlook" },
      ["mail.list"],
      "OUTLOOK"
    );

    const refusedIn = async (
      who: PermissionSubjectInput,
      context: WorkContext,
      read: boolean
    ) => {
      const bindings = await envOf(who, admin.userId, context);
      return [
        await callOutlook(bindings),
        read
          ? await outcome(readerIn(bindings).getDocument(sensitive.noteId))
          : "no read",
      ];
    };
    // Nowhere to keep restricted mode, or someone else's: nothing that would
    // need it runs.
    expect({
      missingChat: await refusedIn(
        subject,
        {
          type: "chat",
          workspaceId: workspaceIdSchema.parse(crypto.randomUUID()),
          chatId: chatIdSchema.parse(crypto.randomUUID()),
        },
        true
      ),
      agentInApp: await refusedIn(subject, { type: "app", appId: own }, true),
      otherApp: await refusedIn(app, { type: "app", appId: other }, true),
      unknownApp: await refusedIn(
        { type: "app", appId: ghost },
        { type: "app", appId: appIdSchema.parse(ghost) },
        false
      ),
    }).toStrictEqual({
      missingChat: ["permission.context_invalid", "permission.context_invalid"],
      agentInApp: ["permission.context_invalid", "permission.context_invalid"],
      otherApp: ["permission.context_invalid", "permission.context_invalid"],
      unknownApp: ["permission.context_invalid", "no read"],
    });
    // Neither App was restricted by reads made in its name.
    await expect(
      Promise.all([
        appHost(env, own).isRestricted(),
        appHost(env, other).isRestricted(),
        callOutlook(
          await envOf(app, admin.userId, { type: "app", appId: own })
        ),
      ])
    ).resolves.toStrictEqual([false, false, reached]);
  });
});
