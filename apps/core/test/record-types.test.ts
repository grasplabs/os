import { appIdSchema, permissionIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { saveDocument } from "../src/knowledge/documents.ts";
import { saveRecordAsDelegate } from "../src/knowledge/records.ts";
import { restrict } from "../src/restricted.ts";
import { grantReviewed, release, requestGranted, serverBuilt } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// Record types an App declares (app/records.json) for a collection it
// writes, and the collection stub that reads and writes them as data
// (knowledge/record-types.ts, knowledge/records.ts). These tests start
// from the ways it can fail: a record that doesn't fit its type is saved
// by someone other than the App (a person editing the text, a restore); a
// type is declared for a collection the App may not write, or by a
// version no admin approved, or after the permission was revoked; a kept
// field is changed by anyone but the method that owns it (a person, the
// App's other methods, another App declaring the same type), dropped by a
// save that leaves it out, or laundered through a version of another
// type: a plain doc, another App's type whose own method sets a field of
// that name, or any type while nobody declares the record's (its owner's
// version unapproved, the flag off); a record of a type no App has any
// more is stuck as it is for good; another App takes a type over, or
// blocks it with a schema of its own; a purge is refused because a
// record's type is no longer declared or its text no longer fits; the
// stub writes without a permission to write, for someone who couldn't
// write themselves, or from a context that read restricted data; the
// write isn't traced to the App, the person and how; and finding the
// types reads a table whole.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string; token: string };
type Stub = Record<string, (caller: Caller, ...args: unknown[]) => Promise<unknown>>;

const outcome = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: (error as { code?: string }).code ?? "failed" };
  }
};

export class App extends DurableObject {
  stub(binding: string): Stub {
    return (this.env as Record<string, Stub>)[binding] ?? {};
  }

  async save(caller: Caller, binding: string, input: unknown): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).saveRecord(caller, input));
  }

  async seal(caller: Caller, binding: string, input: unknown): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).saveRecord(caller, input));
  }

  async canWrite(caller: Caller, binding: string): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).canWrite(caller));
  }

  async record(caller: Caller, binding: string, id: string, version?: number): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).getRecord(caller, id, version));
  }

  async list(caller: Caller, binding: string, type: string): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).listRecords(caller, { type }));
  }
}
`;

/**
 * A `task` type for `collection`: its status, and a seal only `seal` sets
 * (unless not `kept`); the fields it requires are `required`.
 */
const taskTypes = (
  collection: string,
  {
    statuses = ["open", "done"],
    kept = true,
    required = ["status"],
    status = { enum: statuses },
  }: {
    statuses?: string[];
    kept?: boolean;
    required?: string[];
    status?: Record<string, unknown>;
  } = {}
) =>
  JSON.stringify({
    task: {
      collection,
      description: "Something to do",
      schema: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 200 },
          owner: { type: "string", maxLength: 256 },
          status,
          points: { type: "integer", minimum: 0, default: 1 },
          seal: { type: "string", maxLength: 64 },
        },
        required,
      },
      ...(kept ? { kept: [{ method: "seal", fields: ["seal"] }] } : {}),
    },
  });

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** A permission for `app` on `collectionId`, under `binding`. */
const collectionFor = (
  app: AppId,
  collectionId: string,
  actions: string[] = ["read", "write"],
  binding = "TASKS"
): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "collection", collectionId },
  actions,
  binding,
});

/** A new App declaring `records`, released by `admin`. */
const recordsApp = async (admin: Person, records: string): Promise<AppId> => {
  const { id } = await admin.api.apps.create({ name: `Tasks ${unique()}` });
  await serverBuilt(
    id,
    await release(admin, id, {
      "app/server.ts": serverCode,
      "app/records.json": records,
    })
  );
  return appIdSchema.parse(id);
};

/** An admin's collection open to everyone, and an App granted to write it. */
const setUp = async () => {
  const admin = await signedInApi(idp, "admin");
  const { id: collectionId } = await admin.api.knowledge.createCollection({
    name: `Tasks ${unique()}`,
    access: "everyone",
  });
  const app = await recordsApp(admin, taskTypes(collectionId));
  const permissionId = await requestGranted(
    idp,
    admin,
    collectionFor(app, collectionId)
  );
  return { admin, app, collectionId, permissionId };
};

/** A record's text, as a person writes it. */
const taskText = (fields: string) =>
  `---\ntype: task\n${fields}\n---\nDo it.\n`;

/** A stub save of `record` at `path`. */
const saveArgs = (
  path: string,
  record: Record<string, unknown>,
  ifVersion = 0,
  binding = "TASKS"
) => [binding, { path, ifVersion, record, body: "Do it." }];

const savedSchema = z.object({
  ok: z.object({ id: z.string(), currentVersion: z.number() }),
});

const recordSchema = z.object({
  ok: z.object({ record: z.record(z.string(), z.unknown()) }),
});

const readsDocument = /from "documents"/iu;

/** The read of one type's claim in a collection (`typeHeld`). */
const readsClaim = /from "record_type_owners".*"type" = \?/iu;

/**
 * Knowledge's database (or `real`), with `first` run once, just before
 * the first statement whose query `when` matches is run (or the `nth`):
 * another request landing while a write is being prepared.
 */
const racingOn = (
  when: RegExp,
  first: () => Promise<void>,
  real: D1Database = env.KNOWLEDGE,
  nth = 1
): D1Database => {
  let done = false;
  let runs = 0;
  const once = async (): Promise<void> => {
    runs += 1;
    if (!done && runs >= nth) {
      done = true;
      await first();
    }
  };
  const racing = (statement: D1PreparedStatement): D1PreparedStatement =>
    // SAFETY: an object whose prototype is `statement` is a statement: it
    // has every member, and the ones it runs by are replaced below.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    Object.assign(Object.create(statement) as D1PreparedStatement, {
      bind: (...values: unknown[]) => racing(statement.bind(...values)),
      first: async (column?: string) => {
        await once();
        return column === undefined
          ? await statement.first()
          : await statement.first(column);
      },
      all: async () => {
        await once();
        return await statement.all();
      },
      raw: async () => {
        await once();
        return await statement.raw();
      },
      run: async () => {
        await once();
        return await statement.run();
      },
    });
  return {
    prepare: (query) => {
      const statement = real.prepare(query);
      return !done && when.test(query) ? racing(statement) : statement;
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      await real.batch<T>(statements),
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

describe("record types an App declares", { timeout: 60_000 }, () => {
  it("check every save of their records to the collection, whoever saves, and nowhere else", async () => {
    const { admin, app, collectionId } = await setUp();
    const { id: elsewhere } = await admin.api.knowledge.createCollection({
      name: `Elsewhere ${unique()}`,
      access: "everyone",
    });
    const personSave = async (
      text: string,
      collection = collectionId,
      path = `tasks/${unique()}.md`
    ) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: collection,
          path,
          text,
          ifVersion: 0,
        })
      );
    const appSaved = savedSchema.parse(
      await callApp(env, app, as(admin.userId), "save", [
        ...saveArgs(`tasks/${unique()}.md`, {
          type: "task",
          title: "Book the venue",
          status: "open",
        }),
      ])
    );
    const read = recordSchema.parse(
      await callApp(env, app, as(admin.userId), "record", [
        "TASKS",
        appSaved.ok.id,
      ])
    );

    expect({
      app: {
        wrongStatus: await callApp(
          env,
          app,
          as(admin.userId),
          "save",
          saveArgs(`tasks/${unique()}.md`, { type: "task", status: "lost" })
        ),
        // Its defaults filled in, as it reads back.
        read: read.ok.record,
      },
      person: {
        fits: await personSave(taskText("status: done")),
        wrongStatus: await personSave(taskText("status: lost")),
        missingStatus: await personSave(taskText("title: No status")),
        wrongPoints: await personSave(taskText("status: open\npoints: -1")),
        // The fields every type has hold too.
        longTitle: await personSave(
          taskText(`status: open\ntitle: ${"x".repeat(201)}`)
        ),
        // Only for the collection the App declares it for.
        elsewhere: await personSave(taskText("status: open"), elsewhere),
        undeclared: await personSave("---\ntype: invoice\nstatus: open\n---\n"),
      },
    }).toStrictEqual({
      app: {
        wrongStatus: { error: "knowledge.invalid" },
        read: {
          type: "task",
          title: "Book the venue",
          status: "open",
          points: 1,
          description: "",
          tags: [],
        },
      },
      person: {
        fits: "ok",
        wrongStatus: "knowledge.invalid",
        missingStatus: "knowledge.invalid",
        wrongPoints: "knowledge.invalid",
        longTitle: "knowledge.invalid",
        elsewhere: "knowledge.invalid",
        undeclared: "knowledge.invalid",
      },
    });
  });

  it("follow the App's current version, and hold only while it may write the collection", async () => {
    const { admin, app, collectionId, permissionId } = await setUp();
    const path = `tasks/${unique()}.md`;
    const blocked = taskText("status: blocked");
    const refusedBefore = await outcome(
      admin.api.knowledge.saveDocument({
        collectionId,
        path,
        text: blocked,
        ifVersion: 0,
      })
    );
    // A version that also takes `blocked`: expand.
    await release(admin, app, {
      "app/records.json": taskTypes(collectionId, {
        statuses: ["open", "done", "blocked"],
      }),
    });
    const saved = await admin.api.knowledge.saveDocument({
      collectionId,
      path,
      text: blocked,
      ifVersion: 0,
    });
    // Records that don't read are named, not dropped.
    const listed = async () =>
      z
        .object({
          ok: z.object({
            records: z.array(z.object({ id: z.string() })),
            unreadable: z.array(z.object({ id: z.string() })),
          }),
        })
        .parse(
          await callApp(env, app, as(admin.userId), "list", ["TASKS", "task"])
        );
    const whileGranted = await listed();
    // Contract: only `open` and `done` again.
    await release(admin, app, { "app/records.json": taskTypes(collectionId) });
    const afterContract = await listed();
    const invalidCommit = await outcome(
      (async () => {
        await admin.api.apps.files.commit(
          app,
          {
            "app/records.json": JSON.stringify({
              doc: { collection: collectionId, schema: { type: "object" } },
            }),
          },
          "Declare a built-in type"
        );
      })()
    );
    await admin.api.permissions.revoke(permissionId);
    const afterRevoke = await outcome(
      admin.api.knowledge.saveDocument({
        collectionId,
        path: `tasks/${unique()}.md`,
        text: taskText("status: open"),
        ifVersion: 0,
      })
    );
    expect({
      refusedBefore,
      saved: saved.type,
      granted: whileGranted.ok.records.some(({ id }) => id === saved.id),
      contracted: afterContract.ok.unreadable.some(({ id }) => id === saved.id),
      invalidCommit,
      afterRevoke,
    }).toStrictEqual({
      refusedBefore: "knowledge.invalid",
      saved: "task",
      granted: true,
      contracted: true,
      invalidCommit: "app.records_invalid",
      afterRevoke: "knowledge.invalid",
    });
  });

  it("keep a kept field on every write but its own method's", async () => {
    const { admin, app, collectionId } = await setUp();
    // Another App declaring the same type, without keeping the seal: its
    // own `seal` method doesn't set it.
    const other = await recordsApp(
      admin,
      taskTypes(collectionId, { kept: false })
    );
    await requestGranted(idp, admin, collectionFor(other, collectionId));
    const path = `tasks/${unique()}.md`;
    const task = { type: "task", title: "Sign the lease", status: "open" };
    const first = savedSchema.parse(
      await callApp(env, app, as(admin.userId), "save", saveArgs(path, task))
    );
    const sealed = await callApp(
      env,
      app,
      as(admin.userId),
      "seal",
      saveArgs(path, { ...task, seal: "signed" }, 1)
    );
    // Its own method, leaving it out: it is kept too.
    const resealed = await callApp(
      env,
      app,
      as(admin.userId),
      "seal",
      saveArgs(path, { ...task, title: "Sign the lease today" }, 2)
    );
    // Its other method leaves it out: it is kept.
    const kept = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, { ...task, status: "done" }, 3)
    );
    const read = recordSchema.parse(
      await callApp(env, app, as(admin.userId), "record", [
        "TASKS",
        first.ok.id,
      ])
    );
    const plainEdit = async (fields: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId,
          path,
          text: taskText(fields),
          ifVersion: 4,
        })
      );
    expect({
      sealed: savedSchema.safeParse(sealed).success,
      resealed: savedSchema.safeParse(resealed).success,
      kept: savedSchema.safeParse(kept).success,
      read: { seal: read.ok.record.seal, status: read.ok.record.status },
      changedByOtherMethod: await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(path, { ...task, seal: "forged" }, 4)
      ),
      changedByOtherApp: await callApp(
        env,
        other,
        as(admin.userId),
        "seal",
        saveArgs(path, { ...task, seal: "forged" }, 4)
      ),
      changedByPerson: await plainEdit("status: done\nseal: forged"),
      droppedByPerson: await plainEdit("status: done"),
      keptByPerson: await plainEdit("status: open\nseal: signed"),
      // A new record can't start with one either.
      newWithSeal: await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(`tasks/${unique()}.md`, { ...task, seal: "forged" })
      ),
    }).toStrictEqual({
      sealed: true,
      resealed: true,
      kept: true,
      read: { seal: "signed", status: "done" },
      changedByOtherMethod: { error: "knowledge.invalid" },
      changedByOtherApp: { error: "knowledge.invalid" },
      changedByPerson: "knowledge.invalid",
      droppedByPerson: "knowledge.invalid",
      keptByPerson: "ok",
      newWithSeal: { error: "knowledge.invalid" },
    });

    // A version whose type no longer fits the record (it now needs an
    // owner): a save that makes it fit keeps the seal all the same.
    await release(admin, app, {
      "app/records.json": taskTypes(collectionId, {
        required: ["status", "owner"],
      }),
    });
    await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, { ...task, owner: admin.userId }, 5)
    );
    const after = recordSchema.parse(
      await callApp(env, app, as(admin.userId), "record", [
        "TASKS",
        first.ok.id,
      ])
    );
    expect(after.ok.record).toMatchObject({
      seal: "signed",
      owner: admin.userId,
    });

    // It stays a task while it has its seal: a plain doc would drop it,
    // and a task again after it would set it afresh.
    const toDoc = await outcome(
      admin.api.knowledge.saveDocument({
        collectionId,
        path,
        text: "---\ntype: doc\n---\nNo longer a task.\n",
        ifVersion: 6,
      })
    );
    // One without a seal becomes a plain doc, and its earlier version
    // still reads as the task it was.
    const unsealedPath = `tasks/${unique()}.md`;
    const unsealed = savedSchema.parse(
      await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(unsealedPath, { ...task, owner: admin.userId })
      )
    );
    await admin.api.knowledge.saveDocument({
      collectionId,
      path: unsealedPath,
      text: "---\ntype: doc\n---\nNo longer a task.\n",
      ifVersion: 1,
    });
    const earlier = recordSchema.parse(
      await callApp(env, app, as(admin.userId), "record", [
        "TASKS",
        unsealed.ok.id,
        1,
      ])
    );
    expect({ toDoc, earlier: earlier.ok.record }).toMatchObject({
      toDoc: "knowledge.invalid",
      earlier: { type: "task", title: "Sign the lease" },
    });
  });

  it("keep a kept field while nobody declares their type: a record stays of it through a version nobody approved yet, until no App has the type and an admin makes it a doc", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Tasks ${unique()}`,
      access: "everyone",
    });
    const owner = await recordsApp(builder, taskTypes(collectionId));
    const ownerGrant = await requestGranted(
      idp,
      builder,
      collectionFor(owner, collectionId)
    );
    const path = `tasks/${unique()}.md`;
    const task = { type: "task", title: "Sign the lease", status: "open" };
    const sealed = savedSchema.parse(
      await callApp(
        env,
        owner,
        as(admin.userId),
        "seal",
        saveArgs(path, { ...task, seal: "signed" })
      )
    );
    const asDoc = "---\ntype: doc\n---\nNo longer a task.\n";
    const plain = async (text: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId,
          path,
          text,
          ifVersion: 1,
        })
      );
    // A builder makes current a version nobody approved yet: nobody
    // declares `task` meanwhile, so its seal isn't known as kept.
    await release(builder, owner, {
      "app/records.json": taskTypes(collectionId),
      "app/notes.ts": "export const note = 1;\n",
    });
    const unapproved = {
      toDoc: await plain(asDoc),
      unsealed: await plain(taskText("status: open")),
    };
    await grantReviewed(admin.api, ownerGrant);
    const approved = {
      toDoc: await plain(asDoc),
      unsealed: await plain(taskText("status: open")),
    };
    const read = recordSchema.parse(
      await callApp(env, owner, as(admin.userId), "record", [
        "TASKS",
        sealed.ok.id,
      ])
    );
    // Its owner may no longer write the collection: no App has the type
    // any more, and nothing would make the record writable again. An
    // admin, and only an admin, makes it a plain doc, and the log says so.
    await admin.api.permissions.revoke(ownerGrant);
    const released = {
      // The collection's owner, who may write it, as a builder.
      byBuilder: await outcome(
        saveDocument(
          env,
          { ...(await admin.api.whoami()), role: "builder" },
          { collectionId, path, text: asDoc, ifVersion: 1 }
        )
      ),
      toDecision: await plain("---\ntype: decision\n---\nDecided.\n"),
      toDoc: await plain(asDoc),
    };
    const events = await allEvents();
    const refused = {
      toDoc: "knowledge.invalid",
      unsealed: "knowledge.invalid",
    };
    expect({
      unapproved,
      approved,
      version: sealed.ok.currentVersion,
      seal: read.ok.record.seal,
      released,
      audited: events
        .filter(
          ({ action, target }) =>
            action === "knowledge.document.saved" && target?.id === sealed.ok.id
        )
        .map(({ actor, detail }) => [
          actor.type === "person" ? actor.userId : actor.type,
          detail.version,
          detail.releasedType ?? null,
        ]),
    }).toStrictEqual({
      unapproved: refused,
      approved: refused,
      version: 1,
      seal: "signed",
      released: {
        byBuilder: "knowledge.invalid",
        toDecision: "knowledge.invalid",
        toDoc: "ok",
      },
      audited: [
        ["app", 1, null],
        [admin.userId, 2, "task"],
      ],
    });
  });

  it("keep a record of a type no App had that another App claims just as an admin makes it a doc", async () => {
    const { admin, app, collectionId, permissionId } = await setUp();
    const path = `tasks/${unique()}.md`;
    const sealed = savedSchema.parse(
      await callApp(
        env,
        app,
        as(admin.userId),
        "seal",
        saveArgs(path, { type: "task", status: "open", seal: "signed" })
      )
    );
    // Its owner may no longer write the collection: no App has `task`.
    await admin.api.permissions.revoke(permissionId);
    // Another App that declares it there, not yet granted the collection.
    const claimer = await recordsApp(admin, taskTypes(collectionId));
    // The admin's save finds nobody has the type; then, before it writes,
    // the other App is granted the collection and its first record
    // claims the type.
    let claimed = "not tried";
    const racing = racingOn(
      readsClaim,
      async () => {
        await requestGranted(idp, admin, collectionFor(claimer, collectionId));
        claimed = await outcome(
          admin.api.knowledge.saveDocument({
            collectionId,
            path: `tasks/${unique()}.md`,
            text: taskText("status: open"),
            ifVersion: 0,
          })
        );
      },
      env.DB,
      2
    );
    const raced = await outcome(
      saveDocument({ ...env, DB: racing }, await admin.api.whoami(), {
        collectionId,
        path,
        text: "---\ntype: doc\n---\nNo longer a task.\n",
        ifVersion: 1,
      })
    );
    const after = await admin.api.knowledge.getDocument(sealed.ok.id);

    expect({
      claimed,
      raced,
      after: [after.type, after.currentVersion],
    }).toStrictEqual({
      claimed: "ok",
      raced: "knowledge.invalid",
      after: ["task", 1],
    });
  });

  it("carry a kept field over only from a version of the same type, never through a doc or another App's type with a field of that name", async () => {
    const { admin, app, collectionId } = await setUp();
    const path = `tasks/${unique()}.md`;
    const plain = async (text: string, ifVersion: number) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId,
          path,
          text,
          ifVersion,
        })
      );
    // A doc may hold any field: a seal in one sets nothing.
    const asDoc = await plain("---\ntype: doc\nseal: forged\n---\n", 0);
    const toTask = await plain(taskText("status: open\nseal: forged"), 1);
    const toTaskClean = await plain(taskText("status: open"), 1);
    // Nor through the stub: a doc's seal isn't carried into a task.
    const other = `tasks/${unique()}.md`;
    await admin.api.knowledge.saveDocument({
      collectionId,
      path: other,
      text: "---\ntype: doc\nseal: forged\n---\n",
      ifVersion: 0,
    });
    const viaStub = savedSchema.parse(
      await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(other, { type: "task", status: "open" }, 1)
      )
    );
    const read = recordSchema.parse(
      await callApp(env, app, as(admin.userId), "record", [
        "TASKS",
        viaStub.ok.id,
      ])
    );
    // Another App's type there with a `seal` field of its own (not kept):
    // its seal isn't the task's either.
    const noter = await recordsApp(
      admin,
      JSON.stringify({
        note: {
          collection: collectionId,
          schema: {
            type: "object",
            properties: { seal: { type: "string", maxLength: 64 } },
          },
        },
      })
    );
    await requestGranted(idp, admin, collectionFor(noter, collectionId));
    const third = `tasks/${unique()}.md`;
    const asNote = await outcome(
      admin.api.knowledge.saveDocument({
        collectionId,
        path: third,
        text: "---\ntype: note\nseal: forged\n---\n",
        ifVersion: 0,
      })
    );
    const noteToTask = await outcome(
      admin.api.knowledge.saveDocument({
        collectionId,
        path: third,
        text: taskText("status: open\nseal: forged"),
        ifVersion: 1,
      })
    );
    // A third App's type that keeps a `seal` too, set by its own method:
    // that method sets its own type's seal, never the task's, so its save
    // over a sealed task, with a seal or with none, drops nothing.
    const memos = await recordsApp(
      admin,
      JSON.stringify({
        memo: {
          collection: collectionId,
          schema: {
            type: "object",
            properties: { seal: { type: "string", maxLength: 64 } },
          },
          kept: [{ method: "seal", fields: ["seal"] }],
        },
      })
    );
    await requestGranted(idp, admin, collectionFor(memos, collectionId));
    const sealedPath = `tasks/${unique()}.md`;
    const sealed = savedSchema.parse(
      await callApp(
        env,
        app,
        as(admin.userId),
        "seal",
        saveArgs(sealedPath, { type: "task", status: "open", seal: "signed" })
      )
    );
    const asMemo = async (record: Record<string, unknown>) =>
      await callApp(
        env,
        memos,
        as(admin.userId),
        "seal",
        saveArgs(sealedPath, { type: "memo", ...record }, 1)
      );
    const memoOverTask = {
      unset: await asMemo({ seal: undefined }),
      forged: await asMemo({ seal: "forged" }),
    };
    const stillSealed = recordSchema.parse(
      await callApp(env, app, as(admin.userId), "record", [
        "TASKS",
        sealed.ok.id,
      ])
    );
    // Over a task without a seal, its own method does set the memo's.
    const memoOverUnsealed = await callApp(
      env,
      memos,
      as(admin.userId),
      "seal",
      saveArgs(other, { type: "memo", seal: "stamped" }, 2)
    );
    expect({
      asDoc,
      toTask,
      toTaskClean,
      seal: read.ok.record.seal,
      asNote,
      noteToTask,
      memoOverTask,
      stillSealed: [stillSealed.ok.record.type, stillSealed.ok.record.seal],
      memoOverUnsealed: savedSchema.safeParse(memoOverUnsealed).success,
    }).toStrictEqual({
      asDoc: "ok",
      toTask: "knowledge.invalid",
      toTaskClean: "ok",
      seal: undefined,
      asNote: "ok",
      noteToTask: "knowledge.invalid",
      memoOverTask: {
        unset: { error: "knowledge.invalid" },
        forged: { error: "knowledge.invalid" },
      },
      stillSealed: ["task", "signed"],
      memoOverUnsealed: true,
    });
  });

  it("belong to the App that claimed them: another App's, a copy of the same declaration too, is ignored, refused at its commit and named to admins as it asks", async () => {
    const { admin, app, collectionId } = await setUp();
    const builder = await signedInApi(idp, "builder");
    // Another App declaring `task` there, with a status none of the
    // owner's records has, and a type nobody has.
    const taker = await recordsApp(
      builder,
      JSON.stringify({
        ...JSON.parse(
          taskTypes(collectionId, {
            status: { enum: ["archived"] },
            kept: false,
          })
        ),
        memo: { collection: collectionId, schema: { type: "object" } },
      })
    );
    const { id: request } = await builder.api.permissions.request(
      collectionFor(taker, collectionId)
    );
    const shownTo = async (person: Person) => {
      const listed = await person.api.permissions.list({
        type: "app",
        appId: taker,
      });
      return listed.find(({ id }) => id === request)?.recordTypes;
    };
    const shown = {
      admin: await shownTo(admin),
      builder: await shownTo(builder),
    };
    await grantReviewed(admin.api, request);
    const save = async () =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId,
          path: `tasks/${unique()}.md`,
          text: taskText("status: open"),
          ifVersion: 0,
        })
      );
    const commitOf = async (of: AppId, records: string) =>
      await outcome(
        (async () => {
          await admin.api.apps.files.commit(
            of,
            {
              "app/records.json": records,
              "app/notes.ts": `export const note = "${unique()}";\n`,
            },
            "Another change"
          );
        })()
      );
    // A second copy declaring it exactly as the owner does: its seal
    // forges nothing.
    const twin = await recordsApp(admin, taskTypes(collectionId));
    await requestGranted(idp, admin, collectionFor(twin, collectionId));
    const twinSeals = await callApp(
      env,
      twin,
      as(admin.userId),
      "seal",
      saveArgs(`tasks/${unique()}.md`, {
        type: "task",
        status: "open",
        seal: "forged",
      })
    );
    expect({
      shown,
      ownerStillSaves: await save(),
      takerSaves: savedSchema.safeParse(
        await callApp(
          env,
          taker,
          as(admin.userId),
          "save",
          saveArgs(`tasks/${unique()}.md`, { type: "task", status: "open" })
        )
      ).success,
      takerCommit: await commitOf(
        taker,
        taskTypes(collectionId, { kept: false })
      ),
      twinCommit: await commitOf(twin, taskTypes(collectionId)),
      twinSeals,
      ownerApp: await callApp(env, app, as(admin.userId), "canWrite", [
        "TASKS",
      ]),
    }).toStrictEqual({
      shown: {
        admin: { claims: ["memo"], taken: [{ type: "task", owner: app }] },
        builder: { claims: ["memo"], taken: [{ type: "task", owner: null }] },
      },
      ownerStillSaves: "ok",
      // Its records are the owner's type, which it may write as any App.
      takerSaves: true,
      takerCommit: "app.records_invalid",
      twinCommit: "app.records_invalid",
      twinSeals: { error: "knowledge.invalid" },
      ownerApp: { ok: true },
    });
  });

  it("are claimed as their records are first saved, not as Apps are granted and made current, by one App of two saving at once", async () => {
    const admin = await signedInApi(idp, "admin");
    const { id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Tasks ${unique()}`,
      access: "everyone",
    });
    const appWith = async (statuses: string[]): Promise<AppId> => {
      const { id } = await admin.api.apps.create({ name: `Tasks ${unique()}` });
      await admin.api.apps.files.commit(
        id,
        {
          "app/server.ts": serverCode,
          "app/records.json": taskTypes(collectionId, { statuses }),
        },
        "Tasks"
      );
      await admin.api.apps.versions.setCurrent(id, 1);
      const { id: permission } = await admin.api.permissions.request(
        collectionFor(appIdSchema.parse(id), collectionId)
      );
      await admin.api.permissions.grant(permission, { version: 1 });
      return appIdSchema.parse(id);
    };
    await appWith(["open"]);
    await appWith(["done"]);
    const save = async (status: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId,
          path: `tasks/${unique()}.md`,
          text: taskText(`status: ${status}`),
          ifVersion: 0,
        })
      );
    // No admin doing anything: both first saves at once.
    const raced = await Promise.all([save("open"), save("done")]);
    const after = await Promise.all([save("open"), save("done")]);
    expect({
      oneWon: raced.filter((outcomeOf) => outcomeOf === "ok").length,
      same: JSON.stringify(after) === JSON.stringify(raced),
    }).toStrictEqual({ oneWon: 1, same: true });
  });

  it("are claimed again at the next save when a claim failed", async () => {
    const { admin, collectionId } = await setUp();
    const { id: fresh } = await admin.api.knowledge.createCollection({
      name: `Tasks ${unique()}`,
      access: "everyone",
    });
    const app = await recordsApp(admin, taskTypes(fresh));
    await requestGranted(idp, admin, collectionFor(app, fresh));
    // Core's database, failing the batch that claims.
    const real = env.DB;
    let claiming = false;
    const failing: D1Database = {
      prepare: (query) => {
        claiming ||= /^insert into "record_type_owners"/iu.test(query);
        return real.prepare(query);
      },
      batch: async <T>(statements: D1PreparedStatement[]) => {
        if (claiming) {
          claiming = false;
          throw new Error("D1 unavailable");
        }
        return await real.batch<T>(statements);
      },
      exec: async (query) => await real.exec(query),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await real.dump(),
      withSession: (constraint) => real.withSession(constraint),
    };
    const input = (status: string) => ({
      collectionId: fresh,
      path: `tasks/${unique()}.md`,
      text: taskText(`status: ${status}`),
      ifVersion: 0,
    });
    const identity = await admin.api.whoami();
    const failed = await outcome(
      saveDocument({ ...env, DB: failing }, identity, input("open"))
    );
    expect({
      failed: failed === "ok" ? "saved" : "refused",
      next: await outcome(admin.api.knowledge.saveDocument(input("open"))),
      unrelated: collectionId === fresh,
    }).toStrictEqual({ failed: "refused", next: "ok", unrelated: false });
  });

  it("stay the owner's through a version nobody approved yet", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    // An owner a builder builds, whose next version nobody approved yet.
    const other = await signedInApi(idp, "admin");
    const { id: laterId } = await other.api.knowledge.createCollection({
      name: `Tasks ${unique()}`,
      access: "everyone",
    });
    const owner = await recordsApp(
      builder,
      taskTypes(laterId, { statuses: ["open"] })
    );
    const ownerGrant = await requestGranted(
      idp,
      builder,
      collectionFor(owner, laterId)
    );
    const saveLater = async (status: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: laterId,
          path: `tasks/${unique()}.md`,
          text: taskText(`status: ${status}`),
          ifVersion: 0,
        })
      );
    // Its first record claims the type.
    const established = await saveLater("open");
    await release(builder, owner, {
      "app/records.json": taskTypes(laterId, { statuses: ["open"] }),
      "app/notes.ts": "export const note = 1;\n",
    });
    // Meanwhile another App claims: the owner keeps it.
    const challenger = await recordsApp(
      admin,
      taskTypes(laterId, { statuses: ["done"] })
    );
    await requestGranted(idp, admin, collectionFor(challenger, laterId));
    const unapproved = {
      open: await saveLater("open"),
      done: await saveLater("done"),
    };
    await grantReviewed(admin.api, ownerGrant);
    const approved = {
      open: await saveLater("open"),
      done: await saveLater("done"),
    };
    expect({
      established,
      unapproved,
      approved,
    }).toStrictEqual({
      established: "ok",
      // Nobody declares it while the owner's version waits for an admin,
      // and the challenger never got it.
      unapproved: { open: "knowledge.invalid", done: "knowledge.invalid" },
      approved: { open: "ok", done: "knowledge.invalid" },
    });
  });

  it("stay the owner's while a version nobody approved yet drops them, and go once an admin approves it", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "admin");
    const { id: collectionId } = await other.api.knowledge.createCollection({
      name: `Tasks ${unique()}`,
      access: "everyone",
    });
    const owner = await recordsApp(
      builder,
      taskTypes(collectionId, { statuses: ["open"] })
    );
    const ownerGrant = await requestGranted(
      idp,
      builder,
      collectionFor(owner, collectionId)
    );
    const save = async (status: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId,
          path: `tasks/${unique()}.md`,
          text: taskText(`status: ${status}`),
          ifVersion: 0,
        })
      );
    const established = await save("open");
    // A builder makes current a version that no longer declares the type.
    await release(builder, owner, { "app/records.json": "{}\n" });
    const challenger = await recordsApp(
      admin,
      taskTypes(collectionId, { statuses: ["done"] })
    );
    await requestGranted(idp, admin, collectionFor(challenger, collectionId));
    const unapproved = { open: await save("open"), done: await save("done") };
    await grantReviewed(admin.api, ownerGrant);
    const approved = { open: await save("open"), done: await save("done") };
    expect({ established, unapproved, approved }).toStrictEqual({
      established: "ok",
      // The unapproved drop hands nothing over: nobody declares it meanwhile.
      unapproved: { open: "knowledge.invalid", done: "knowledge.invalid" },
      // Approved, the owner no longer declares it: the challenger claims it.
      approved: { open: "knowledge.invalid", done: "ok" },
    });
  });

  it("don't stop a purge: a record whose type is no longer declared, or no longer fits, is purged all the same", async () => {
    const { admin, app, collectionId, permissionId } = await setUp();
    const name = `Anna${unique()}`;
    const fits = await admin.api.knowledge.saveDocument({
      collectionId,
      path: `tasks/${unique()}.md`,
      text: taskText(`status: open\ntitle: Call ${name}`),
      ifVersion: 0,
    });
    const narrowed = await admin.api.knowledge.saveDocument({
      collectionId,
      path: `tasks/${unique()}.md`,
      text: taskText(`status: done\ntitle: Thank ${name}`),
      ifVersion: 0,
    });
    // `done` no longer fits, then the type isn't declared at all.
    await release(admin, app, {
      "app/records.json": taskTypes(collectionId, { statuses: ["open"] }),
    });
    const whileNarrowed = await admin.api.knowledge.preparePurge({
      type: "content",
      documentIds: [narrowed.id],
      terms: [name],
      reason: "erasure_request",
    });
    await admin.api.knowledge.purge(
      {
        type: "content",
        documentIds: [narrowed.id],
        terms: [name],
        reason: "erasure_request",
      },
      whileNarrowed.token
    );
    await admin.api.permissions.revoke(permissionId);
    const input = {
      type: "content" as const,
      documentIds: [fits.id],
      terms: [name],
      reason: "erasure_request" as const,
    };
    const plan = await admin.api.knowledge.preparePurge(input);
    await admin.api.knowledge.purge(input, plan.token);
    const texts = await Promise.all(
      [fits.id, narrowed.id].map(async (id) => {
        const read = await admin.api.knowledge.getDocument(id);
        return read.version.text.includes(name);
      })
    );
    expect(texts).toStrictEqual([false, false]);

    // A term that is the type's own name goes from the frontmatter too: the
    // record is then of a type nobody can declare, which an admin's save
    // as a plain doc takes it out of.
    const typeName = { ...input, terms: ["task"] };
    const typePlan = await admin.api.knowledge.preparePurge(typeName);
    await admin.api.knowledge.purge(typeName, typePlan.token);
    const purged = await admin.api.knowledge.getDocument(fits.id);
    const asDoc = await admin.api.knowledge.saveDocument({
      collectionId,
      path: purged.path,
      text: "---\ntype: doc\n---\nNo longer a task.\n",
      ifVersion: purged.currentVersion,
    });
    expect({
      purged: [purged.type, purged.version.text.split("\n")[1]],
      asDoc: asDoc.type,
    }).toStrictEqual({ purged: ["doc", "type: (removed)"], asDoc: "doc" });
  });

  it("are found by the index of permissions by their object, not by reading a table whole", async () => {
    const { admin, collectionId } = await setUp();
    const recorded = await recordedQueries(async () => {
      await admin.api.knowledge.saveDocument({
        collectionId,
        path: `tasks/${unique()}.md`,
        text: taskText("status: open"),
        ifVersion: 0,
      });
    });
    const lookups = recorded.filter(
      ({ query }) =>
        query.includes('json_each("permissions"."actions")') &&
        !query.includes('from "record_type_owners"')
    );
    const owners = recorded.filter(({ query }) =>
      query.includes('from "record_type_owners"')
    );
    const plans = await Promise.all(lookups.map(planOf));
    const ownerPlans = await Promise.all(owners.map(planOf));
    expect({
      lookups: lookups.length,
      // Read, and on the collection's first save claimed and read back.
      owners: owners.length > 0,
      scans: [...plans, ...ownerPlans]
        .flat()
        .filter((step) => fullScan.test(step)),
      byObject: plans.every((plan) =>
        plan.some((step) => step.includes("permissions_object_idx"))
      ),
    }).toStrictEqual({ lookups: 1, owners: true, scans: [], byObject: true });
  });
});

describe("a collection stub's records", { timeout: 60_000 }, () => {
  it("are written only under a permission to write, for who may write themselves, traced to the App", async () => {
    const { admin, app, collectionId } = await setUp();
    const user = await signedInApi(idp, "user");
    await requestGranted(
      idp,
      admin,
      collectionFor(app, collectionId, ["read"], "TASKS_READ")
    );
    const path = `tasks/${unique()}.md`;
    const task = { type: "task", status: "open" };
    const hinted = {
      admin: await callApp(env, app, as(admin.userId), "canWrite", ["TASKS"]),
      user: await callApp(env, app, as(user.userId), "canWrite", ["TASKS"]),
      readOnly: await callApp(env, app, as(admin.userId), "canWrite", [
        "TASKS_READ",
      ]),
    };
    let saved: unknown;
    const events = await auditedDuring(async () => {
      saved = await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(path, task)
      );
    });
    expect({
      hinted,
      user: await callApp(
        env,
        app,
        as(user.userId),
        "save",
        saveArgs(`tasks/${unique()}.md`, task)
      ),
      readOnly: await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(`tasks/${unique()}.md`, task, 0, "TASKS_READ")
      ),
      saved: savedSchema.safeParse(saved).success,
      events: events
        .filter(({ action }) => action === "knowledge.document.saved")
        .map(({ actor, detail }) => ({ actor, detail })),
    }).toStrictEqual({
      hinted: {
        admin: { ok: true },
        user: { ok: false },
        readOnly: { ok: false },
      },
      user: { error: "knowledge.forbidden" },
      readOnly: { error: "permission.denied" },
      saved: true,
      events: [
        {
          actor: { type: "app", appId: app, part: "server" },
          detail: {
            onBehalfOf: admin.userId,
            mode: "interactive",
            appVersion: 1,
            collectionId,
            version: 1,
          },
        },
      ],
    });
  });

  it("aren't written from a context that read restricted data, even when it does so as the save is prepared", async () => {
    const { admin, app, collectionId, permissionId } = await setUp();
    const authority = {
      subject: { type: "app" as const, appId: app },
      onBehalfOf: admin.userId,
      mode: "interactive" as const,
      appVersion: 1,
    };
    const context = { type: "app" as const, appId: app };
    const path = `tasks/${unique()}.md`;
    let raced = false;
    const racing = racingOn(readsDocument, async () => {
      raced = true;
      await restrict(env, authority, context, ["payroll"]);
    });
    const refused = await outcome(
      saveRecordAsDelegate(
        { ...env, KNOWLEDGE: racing },
        authority,
        context,
        permissionIdSchema.parse(permissionId),
        collectionId,
        {
          path,
          ifVersion: 0,
          record: { type: "task", status: "open" },
          body: "",
        }
      )
    );
    const written = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS count FROM documents WHERE collection_id = ? AND path = ?"
    )
      .bind(collectionId, path)
      .first<{ count: number }>();
    expect({
      raced,
      refused,
      written: written?.count,
      after: await callApp(
        env,
        app,
        as(admin.userId),
        "save",
        saveArgs(`tasks/${unique()}.md`, { type: "task", status: "open" })
      ),
    }).toStrictEqual({
      raced: true,
      refused: "permission.restricted",
      written: 0,
      after: { error: "permission.restricted" },
    });
  });
});
