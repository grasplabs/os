import {
  appIdSchema,
  chatIdSchema,
  workspaceIdSchema,
} from "@grasp-os/shared/ids";
import type {
  CollectionReader,
  KnowledgeApi,
} from "@grasp-os/shared/knowledge";
import type {
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appHost } from "../src/durable-objects.ts";
import type { WorkContext } from "../src/restricted.ts";
import { workspace } from "../src/workspace.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import {
  actingFor,
  collectionIn,
  connectionIn,
  envOf,
  newChat,
  reached,
} from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  collectionWithNote,
  newTeam,
  readCollection,
  storedGrant,
} from "./knowledge.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  auditedDuring,
  callAuth,
  outcome,
  signedInApi,
  unique,
} from "./sign-in.ts";

// Knowledge as Apps and agents reach it, and restricted mode. These tests
// start from the ways it can fail: an App or agent reads what it has no
// permission for, or what the person it acts for can't read (R5); a listing,
// history or backlink shows something of a collection it can't read (R11);
// a read of sensitive data comes back unmarked (R12); and a chat or App
// that read restricted data still acts in outside systems, also after its
// object restarts (Q12).

const idp = mockIdp();

/**
 * Each test signs people in and has permissions granted before it
 * reads anything, which on a loaded CI runner can take as long as Vitest's
 * default 5 seconds per test.
 */
const setUpTime = { timeout: 60_000 };

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

const outlook = (subject: PermissionSubjectInput): PermissionRequest => ({
  subject,
  object: { type: "connection", connectionId: "connection-outlook" },
  actions: ["mail.list", "mail.send"],
  binding: "OUTLOOK",
});

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

/** A fetch from Outlook, from an env. */
const callOutlook = async (bindings: Env) => {
  const stub = connectionIn(bindings, "OUTLOOK");
  if (!stub) {
    throw new Error("No OUTLOOK binding");
  }
  return await outcome(stub.call("mail.list", {}));
};

/** A side effect, a mail sent, from an env. */
const sendMail = async (bindings: Env) => {
  const stub = connectionIn(bindings, "MAIL");
  if (!stub) {
    throw new Error("No MAIL binding");
  }
  return await outcome(
    stub.call(
      "mail.send",
      { to: "x@elsewhere.test", subject: "Payroll" },
      { idempotencyKey: unique() }
    )
  );
};

/** A side effect from chat, until connect holds it for the person. */
const unconfirmed = "connect.confirmation_required";

describe("Apps and agents reading Knowledge", setUpTime, () => {
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
    const before = await envOf(actingFor(agent, admin.userId), context);
    const { id: permissionId } = await admin.api.permissions.request(
      readCollection(agent, handbook.collectionId)
    );
    const whileRequested = await envOf(actingFor(agent, admin.userId), context);
    await requestGranted(idp, admin, {
      ...readCollection(agent, handbook.collectionId, "HANDBOOK_WRITE"),
      actions: ["write"],
    });
    const writeOnly = readerIn(
      await envOf(actingFor(agent, admin.userId), context),
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
    const reader = readerIn(
      await envOf(actingFor(agent, admin.userId), context)
    );
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

  it("read nothing, and call out to nothing, while Knowledge or connections are switched off", async () => {
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
    await requestGranted(idp, admin, outlook(agent));
    const bindings = await envOf(
      actingFor(agent, admin.userId),
      await newChat()
    );
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    let whileOff: { reads: string[]; call: string };
    try {
      env.FEATURES = { ...on, knowledge: false, connections: false };
      whileOff = {
        reads: await everyRead(readerIn(bindings), handbook.noteId),
        call: await callOutlook(bindings),
      };
    } finally {
      env.FEATURES = features;
    }
    // The stubs it holds work again once they are switched on.
    expect({
      whileOff,
      backOn: {
        reads: await everyRead(readerIn(bindings), handbook.noteId),
        call: await callOutlook(bindings),
      },
    }).toStrictEqual({
      whileOff: {
        reads: everyReadIs("feature.disabled"),
        call: "feature.disabled",
      },
      backOn: { reads: everyReadIs("ok"), call: reached },
    });
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
    await requestGranted(
      idp,
      admin,
      readCollection(agent, finance.collectionId)
    );
    const readsAs = async (person: Person) =>
      await everyRead(
        readerIn(await envOf(actingFor(agent, person.userId))),
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
    const held = readerIn(await envOf(actingFor(agent, member.userId)));
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
      await envOf(actingFor(agent, owner.userId)),
      "DIARY"
    );
    const inApp = readerIn(
      await envOf(actingFor(app, owner.userId), {
        type: "app",
        appId: app.appId,
      }),
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

    // Nor is a request for one that is stored anyway ever granted.
    const asker = { type: "agent" as const, id: `agent-${unique()}` };
    const personal = await storedGrant(
      asker,
      { type: "collection", id: diary.collectionId },
      ["read"],
      "DIARY",
      "requested"
    );
    const missing = await storedGrant(
      asker,
      { type: "collection", id: "no-such-collection" },
      ["read"],
      "MISSING",
      "requested"
    );
    let grants: string[] = [];
    const events = await auditedDuring(async () => {
      grants = [
        await outcome(admin.api.permissions.grant(personal)),
        await outcome(admin.api.permissions.grant(missing)),
      ];
    });
    const listed = await admin.api.permissions.list({
      type: "agent",
      agentId: asker.id,
    });
    expect({
      grants,
      statuses: Object.fromEntries(
        listed.map((permission) => [permission.id, permission.status])
      ),
      granted: events.filter(({ action }) => action === "permission.granted"),
    }).toStrictEqual({
      grants: ["permission.invalid", "permission.invalid"],
      statuses: { [personal]: "requested", [missing]: "requested" },
      granted: [],
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
    await requestGranted(
      idp,
      admin,
      readCollection(agent, secret.collectionId)
    );
    const reader = readerIn(await envOf(actingFor(agent, outsider.userId)));

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

describe("provenance", setUpTime, () => {
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
    await requestGranted(
      idp,
      admin,
      readCollection(agent, sensitive.collectionId)
    );
    await requestGranted(
      idp,
      admin,
      readCollection(agent, ordinary.collectionId, "OTHER")
    );
    const bindings = await envOf(actingFor(agent, admin.userId));

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

describe("restricted mode", setUpTime, () => {
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
    await requestGranted(
      idp,
      admin,
      readCollection(subject, sensitive.collectionId)
    );
    await requestGranted(
      idp,
      admin,
      readCollection(subject, ordinary.collectionId, "OTHER")
    );
    await requestGranted(idp, admin, outlook(subject));
    const mail = await mailConnection();
    await requestGranted(idp, admin, {
      subject,
      object: { type: "connection", connectionId: mail.id },
      actions: ["mail.send"],
      binding: "MAIL",
    });
    return { admin, subject, sensitive, ordinary, mail };
  };

  it("stops a chat's actions in outside systems for good once it read restricted data", async () => {
    const { admin, subject, sensitive, ordinary, mail } = await setUp();
    const chat = await newChat();
    const otherChat = await newChat();
    const bindings = await envOf(actingFor(subject, admin.userId), chat);

    // Reading ordinary Knowledge changes nothing.
    await readerIn(bindings, "OTHER").getDocument(ordinary.noteId);
    const beforeRestricted = await Promise.all([
      callOutlook(bindings),
      sendMail(bindings),
    ]);
    await readerIn(bindings).getDocument(sensitive.noteId);
    const afterRestricted = await Promise.all([
      // A fetch still reaches connect, which lets declared reads through.
      callOutlook(bindings),
      sendMail(bindings),
      // Knowledge stays inside the deployment, so it can still be read.
      outcome(readerIn(bindings, "OTHER").getDocument(ordinary.noteId)),
    ]);
    expect({ beforeRestricted, afterRestricted }).toStrictEqual({
      beforeRestricted: [reached, unconfirmed],
      afterRestricted: [reached, "connect.restricted", "ok"],
    });

    // Its workspace restarts, and the chat gets a new env: still restricted.
    await evictDurableObject(workspace(env, chat.workspaceId));
    const rebuilt = await envOf(actingFor(subject, admin.userId), chat);
    const other = await envOf(actingFor(subject, admin.userId), otherChat);
    expect({
      restarted: await Promise.all([callOutlook(rebuilt), sendMail(rebuilt)]),
      // Another chat is its own: it read nothing restricted.
      otherChat: await sendMail(other),
      server: await mail.did(),
    }).toStrictEqual({
      restarted: [reached, "connect.restricted"],
      otherChat: unconfirmed,
      server: { calls: 0, sent: [] },
    });
  });

  it("is entered by listings, history, backlinks and searches too, also those that find nothing", async () => {
    const { admin, subject, sensitive } = await setUp();
    // What finds nothing in a sensitive collection still tells something
    // of it: a search for a word, or for a version, candidate by candidate.
    const reads = [
      async (reader: CollectionReader) => await reader.listDocuments(),
      async (reader: CollectionReader) =>
        await reader.history(sensitive.noteId),
      async (reader: CollectionReader) =>
        await reader.backlinks(sensitive.noteId),
      async (reader: CollectionReader) => await reader.search("note"),
      async (reader: CollectionReader) =>
        await reader.search(`nothing${unique()}`),
      async (reader: CollectionReader) => await reader.search(""),
      async (reader: CollectionReader) =>
        await reader.getDocument(sensitive.noteId, 99),
    ];
    const results = await Promise.all(
      reads.map(async (read) => {
        const bindings = await envOf(actingFor(subject, admin.userId));
        await outcome(read(readerIn(bindings)));
        return await sendMail(bindings);
      })
    );
    expect(results).toStrictEqual(reads.map(() => "connect.restricted"));
  });

  it("isn't entered by a read that was refused, or one of an ordinary collection that found nothing", async () => {
    const { admin, subject, sensitive, ordinary } = await setUp();
    const outsider = await personOf("user");
    const bindings = await envOf(actingFor(subject, outsider.userId));
    // The permission covers Outlook for the outsider too; Payroll isn't theirs.
    const refused = await Promise.all([
      outcome(readerIn(bindings).getDocument(sensitive.noteId)),
      outcome(readerIn(bindings).search(`nothing${unique()}`)),
    ]);
    const searched = await envOf(actingFor(subject, admin.userId));
    const { hits, provenance } = await readerIn(searched, "OTHER").search(
      `nothing${unique()}`
    );
    const noVersion = await outcome(
      readerIn(searched, "OTHER").getDocument(ordinary.noteId, 99)
    );
    expect({
      refused,
      call: await sendMail(bindings),
      found: { hits, provenance },
      noVersion,
      afterSearch: await sendMail(searched),
    }).toStrictEqual({
      refused: ["knowledge.not_found", "knowledge.not_found"],
      call: unconfirmed,
      found: {
        hits: [],
        provenance: {
          collectionIds: [ordinary.collectionId],
          sensitive: false,
          restricted: false,
        },
      },
      noVersion: "knowledge.not_found",
      afterSearch: unconfirmed,
    });
  });

  it("stops an App's actions in outside systems for good once it read restricted data", async () => {
    const creator = await personOf("admin");
    const { id } = await creator.api.apps.create({ name: `App ${unique()}` });
    const appId = appIdSchema.parse(id);
    const { admin, subject, sensitive } = await setUp({ type: "app", appId });
    const context: WorkContext = { type: "app", appId };
    const bindings = await envOf(actingFor(subject, admin.userId), context);

    const before = await sendMail(bindings);
    await readerIn(bindings).getDocument(sensitive.noteId);
    await evictDurableObject(appHost(env, appId));
    const after = await sendMail(
      await envOf(actingFor(subject, admin.userId), context)
    );
    expect({ before, after }).toStrictEqual({
      before: unconfirmed,
      after: "connect.restricted",
    });
  });

  it("is audited once, when a chat or an App enters it, with what put it there", async () => {
    const creator = await personOf("admin");
    const { id } = await creator.api.apps.create({ name: `App ${unique()}` });
    const appId = appIdSchema.parse(id);
    const app = { type: "app" as const, appId };
    const agent = newAgent();
    const { admin, sensitive, ordinary } = await setUp(agent);
    await requestGranted(
      idp,
      admin,
      readCollection(app, sensitive.collectionId)
    );
    await requestGranted(
      idp,
      admin,
      readCollection(app, ordinary.collectionId, "OTHER")
    );
    const chat = await newChat();
    const inChat = await envOf(actingFor(agent, admin.userId), chat);
    const inApp = await envOf(actingFor(app, admin.userId), app);
    // An ordinary read restricts nothing; the first restricted one does, and
    // the second finds it restricted already.
    for (const bindings of [inChat, inApp]) {
      // oxlint-disable-next-line no-await-in-loop -- one context at a time
      await readerIn(bindings, "OTHER").getDocument(ordinary.noteId);
      // oxlint-disable-next-line no-await-in-loop -- one context at a time
      await readerIn(bindings).getDocument(sensitive.noteId);
      // oxlint-disable-next-line no-await-in-loop -- one context at a time
      await readerIn(bindings).search("note");
    }
    const audited = await vi.waitFor(async () => {
      const events = await allEvents();
      const restricted = events.filter(
        ({ action, target }) =>
          action === "context.restricted" &&
          (target?.id === chat.chatId || target?.id === appId)
      );
      expect(restricted).toHaveLength(2);
      return restricted;
    });
    expect(
      audited.map(({ actor, target, provenance, detail }) => ({
        actor,
        target,
        provenance,
        detail,
      }))
    ).toStrictEqual([
      {
        actor: {
          type: "agent",
          agentId: agent.agentId,
          onBehalfOf: admin.userId,
        },
        target: { type: "chat", id: chat.chatId },
        provenance: [sensitive.collectionId],
        detail: { workspace: chat.workspaceId },
      },
      {
        actor: { type: "app", appId, part: "server" },
        target: { type: "app", id: appId },
        provenance: [sensitive.collectionId],
        detail: {},
      },
    ]);
  });

  it("records entering restricted mode before setting it, so a failed record restricts nothing", async () => {
    const creator = await personOf("admin");
    const { id } = await creator.api.apps.create({ name: `App ${unique()}` });
    const appId = appIdSchema.parse(id);
    const app = { type: "app" as const, appId };
    const { admin, sensitive } = await setUp();
    await requestGranted(
      idp,
      admin,
      readCollection(app, sensitive.collectionId)
    );
    const inApp = await envOf(actingFor(app, admin.userId), app);
    // Core's outbox refuses every event, as a failing database would.
    await env.DB.prepare(
      "CREATE TRIGGER outbox_unavailable BEFORE INSERT ON audit_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END"
    ).run();
    let failedRead: unknown;
    let restrictedAfterFailure: boolean;
    try {
      failedRead = await outcome(readerIn(inApp).getDocument(sensitive.noteId));
      restrictedAfterFailure = await appHost(env, appId).isRestricted();
    } finally {
      await env.DB.prepare("DROP TRIGGER outbox_unavailable").run();
    }
    // The next restricted read records it, and restricts.
    await readerIn(inApp).getDocument(sensitive.noteId);
    const events = await vi.waitFor(async () => {
      const all = await allEvents();
      const restricted = all.filter(
        ({ action, target }) =>
          action === "context.restricted" && target?.id === appId
      );
      expect(restricted).toHaveLength(1);
      return restricted;
    });
    expect({
      failedRead,
      restrictedAfterFailure,
      restrictedNow: await appHost(env, appId).isRestricted(),
      events: events.length,
    }).toStrictEqual({
      failedRead: "internal.unexpected",
      restrictedAfterFailure: false,
      restrictedNow: true,
      events: 1,
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
    await requestGranted(idp, admin, outlook(app));
    await requestGranted(
      idp,
      admin,
      readCollection(app, sensitive.collectionId)
    );
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
      const bindings = await envOf(actingFor(who, admin.userId), context);
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
          await envOf(actingFor(app, admin.userId), { type: "app", appId: own })
        ),
      ])
    ).resolves.toStrictEqual([false, false, reached]);
  });
});
