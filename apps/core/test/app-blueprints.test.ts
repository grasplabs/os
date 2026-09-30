import type { CreatedFromBlueprint } from "@grasp-os/shared/apps";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { createFromBlueprint } from "../src/app-blueprints.ts";
import { outlook, release, requestGranted, serverBuilt } from "./apps.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { storedGrant } from "./knowledge.ts";
import { mailConnection } from "./mail-connection.ts";
import { racingDb } from "./racing-db.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { connectDb } from "./test-env.ts";

// Blueprints: a builder marks a version of an App as a blueprint, and
// whoever has a role in the App and builds creates an App of their own
// from it: the same code, none of the data, and requests for what the App
// was given. The ways this could go wrong, tried below: data, settings or
// people coming along (the source's AGENTS.md too), a grant coming along instead of a request, a
// blueprint made of a version nobody marked, someone without a role in
// the App (or who doesn't build, or staff) copying it, and a change
// nobody recorded.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const serverCode = `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  notes(): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (note TEXT)");
    return this.ctx.storage.sql
      .exec("SELECT note FROM notes")
      .toArray()
      .map((row) => String(row.note));
  }

  addNote(_caller: unknown, note: string): string[] {
    this.notes();
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", note);
    return this.notes();
  }
}
`;

/** A copy has every file of it but AGENTS.md, which starts as a stub. */
const v1 = {
  "app/server.ts": serverCode,
  "screens/notes.tsx": "export default () => <p>Notes</p>;\n",
  "AGENTS.md": "# Notes\n",
};

/** A released App of `owner`'s at version 1, with a version 2 after it. */
const notesApp = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Notes ${unique()}` });
  await release(owner, id, v1);
  await owner.api.apps.files.commit(
    id,
    { "AGENTS.md": "# Notes, v2\n" },
    "Version 2"
  );
  return id;
};

/** Shares `app` with `person` in `role`. */
const share = async (
  owner: Person,
  app: string,
  person: Person,
  role: "user" | "builder"
): Promise<void> => {
  await owner.api.apps.members.add(app, {
    type: "person",
    id: person.userId,
    role,
  });
};

const named = { name: "My notes", description: "Mine" };

/** Rows ordered by their binding. */
const byBinding = (one: { binding: string }, other: { binding: string }) =>
  one.binding.localeCompare(other.binding);

/** A personal connection of `owner`'s, such as their mailbox. */
const mailboxOf = async (owner: Person): Promise<string> => {
  const id = `connection-mailbox-${unique()}`;
  const now = Date.now();
  await connectDb()
    .prepare(
      "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', ?, ?)"
    )
    .bind(id, owner.userId, now, now)
    .run();
  return id;
};

// The first test builds the server code of two Apps, the source and the
// copy, one after the other (the build cache keys builds by App, so the
// copy's can't reuse the source's), and calls each once. That is the
// point of it: the copy runs the same code with none of the data. On its
// own it takes about 1.5 seconds, but on a loaded runner the two builds
// pushed it past the default five. Nothing polls or sleeps: the only
// deadlines are the two calls' ten seconds each (`APP_CALL_TIMEOUT_MS`),
// which end a call that hangs. Sixty seconds is room for a slow runner,
// as the other tests that release Apps give theirs.
describe("blueprints", { timeout: 60_000 }, () => {
  it("ask only for the workflows and exports of Apps their creator has a role in, and never name the others", async () => {
    const [owner, maker] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const source = await notesApp(owner);
    const [visible, hidden] = await Promise.all([
      notesApp(owner),
      notesApp(owner),
    ]);
    await share(owner, visible, maker, "user");
    const asks = async (
      binding: string,
      object:
        | { type: "workflow"; appId: string; workflowId: string }
        | { type: "app"; appId: string }
    ) =>
      await owner.api.permissions.request({
        subject: { type: "app", appId: source },
        object,
        actions: object.type === "app" ? ["read"] : ["start"],
        binding,
      });
    for (const [binding, object] of [
      ["VISIBLE_CRM", { type: "app", appId: visible }],
      [
        "VISIBLE_FLOW",
        { type: "workflow", appId: visible, workflowId: "report" },
      ],
      ["HIDDEN_CRM", { type: "app", appId: hidden }],
      [
        "HIDDEN_FLOW",
        { type: "workflow", appId: hidden, workflowId: "report" },
      ],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      await asks(binding, object);
    }
    await share(owner, source, maker, "user");
    await owner.api.apps.blueprints.mark(source, 1);

    const made: CreatedFromBlueprint[] = [];
    const events = await auditedDuring(async () => {
      made.push(await maker.api.apps.blueprints.create(source, 1, named));
    });
    const [created] = made;

    expect({
      asked: created?.permissions
        .map(({ object, binding }) => ({ object, binding }))
        .toSorted(byBinding),
      droppedApps: created?.droppedApps.toSorted(byBinding),
      recorded: events
        .filter(({ action }) => action === "app.blueprint.app_dropped")
        .map(({ detail }) => ({
          type: detail.objectType,
          binding: String(detail.binding),
          fromApp: detail.fromApp,
        }))
        .toSorted(byBinding),
      // Nothing it answers or lists names the App they can't see.
      namesHidden:
        JSON.stringify(created).includes(hidden) ||
        JSON.stringify(await maker.api.permissions.list()).includes(hidden),
    }).toStrictEqual({
      asked: [
        { object: { type: "app", appId: visible }, binding: "VISIBLE_CRM" },
        {
          object: { type: "workflow", appId: visible, workflowId: "report" },
          binding: "VISIBLE_FLOW",
        },
      ],
      droppedApps: [
        { type: "app", binding: "HIDDEN_CRM" },
        { type: "workflow", binding: "HIDDEN_FLOW" },
      ],
      recorded: [
        { type: "app", binding: "HIDDEN_CRM", fromApp: source },
        { type: "workflow", binding: "HIDDEN_FLOW", fromApp: source },
      ],
      namesHidden: false,
    });

    // While calls between Apps are off, no App's exports are asked for.
    const off = await createFromBlueprint(
      {
        ...env,
        FEATURES: {
          ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
          app_calls: false,
        },
      },
      await maker.api.whoami(),
      source,
      1,
      { name: `Off ${unique()}` }
    );
    expect({
      asked: off.permissions.map(({ binding }) => binding),
      droppedApps: off.droppedApps.toSorted(byBinding),
    }).toStrictEqual({
      asked: ["VISIBLE_FLOW"],
      droppedApps: [
        { type: "app", binding: "HIDDEN_CRM" },
        { type: "workflow", binding: "HIDDEN_FLOW" },
        { type: "app", binding: "VISIBLE_CRM" },
      ],
    });
  });

  it("drop a request on an App its creator loses their role in while the copy is made", async () => {
    const [owner, maker] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const source = await notesApp(owner);
    const crm = await notesApp(owner);
    await share(owner, crm, maker, "user");
    await owner.api.permissions.request({
      subject: { type: "app", appId: source },
      object: { type: "app", appId: crm },
      actions: ["read"],
      binding: "CRM",
    });
    await owner.api.permissions.request({
      subject: { type: "app", appId: source },
      object: { type: "workflow", appId: crm, workflowId: "report" },
      actions: ["start"],
      binding: "CRM_FLOW",
    });
    await share(owner, source, maker, "user");
    await owner.api.apps.blueprints.mark(source, 1);
    // The CRM stops being shared with them after the copy checked it,
    // just before the batch that creates the copy lands.
    let unshared = false;
    const racing = racingDb(async (db) => {
      if (!unshared) {
        unshared = true;
        await db
          .prepare("DELETE FROM app_members WHERE app_id = ? AND member_id = ?")
          .bind(crm, maker.userId)
          .run();
      }
    });

    let created: CreatedFromBlueprint | undefined;
    const events = await auditedDuring(async () => {
      created = await createFromBlueprint(
        { ...env, DB: racing },
        await maker.api.whoami(),
        source,
        1,
        { name: `Raced ${unique()}` }
      );
    });
    const stored = await env.DB.prepare(
      "SELECT count(*) AS count FROM permissions WHERE subject_id = ? AND object_id = ?"
    )
      .bind(created?.app.id ?? "", crm)
      .first<{ count: number }>();

    expect({
      raced: unshared,
      permissions: created?.permissions,
      droppedApps: created?.droppedApps.toSorted(byBinding),
      stored: stored?.count,
      requested: events.filter(
        ({ action }) => action === "permission.requested"
      ).length,
      dropped: events
        .filter(({ action }) => action === "app.blueprint.app_dropped")
        .map(({ detail }) => String(detail.binding))
        .toSorted((one, other) => one.localeCompare(other)),
      namesCrm: JSON.stringify(created).includes(crm),
    }).toStrictEqual({
      raced: true,
      permissions: [],
      droppedApps: [
        { type: "app", binding: "CRM" },
        { type: "workflow", binding: "CRM_FLOW" },
      ],
      stored: 0,
      // No request was recorded for what the copy doesn't ask for.
      requested: 0,
      dropped: ["CRM", "CRM_FLOW"],
      namesCrm: false,
    });
  });

  it("create an App with the same code, none of the data, and requests for what it was given", async () => {
    const [owner, maker, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const source = await notesApp(owner);
    const [mail, other] = await Promise.all([
      mailConnection(),
      mailConnection(),
    ]);
    await requestGranted(idp, owner, {
      ...outlook(source, "MAIL"),
      object: { type: "connection", connectionId: mail.id },
    });
    await owner.api.permissions.request({
      ...outlook(source, "OTHER"),
      object: { type: "connection", connectionId: other.id },
    });
    await owner.api.permissions.request({
      subject: { type: "app", appId: source },
      object: { type: "workflow", appId: source, workflowId: "report" },
      actions: ["start"],
      binding: "REPORT",
    });
    // Personal connections: the maker's own comes along, the owner's not.
    const [ownersMailbox, makersMailbox] = await Promise.all([
      mailboxOf(owner),
      mailboxOf(maker),
    ]);
    await owner.api.permissions.request({
      ...outlook(source, "OWNERS"),
      object: { type: "connection", connectionId: ownersMailbox },
    });
    await owner.api.permissions.request({
      ...outlook(source, "MAKERS"),
      object: { type: "connection", connectionId: makersMailbox },
    });
    // One connect doesn't know doesn't come along either.
    const ghost = `connection-ghost-${unique()}`;
    await owner.api.permissions.request({
      ...outlook(source, "GHOST"),
      object: { type: "connection", connectionId: ghost },
    });
    const revoked = await requestGranted(idp, owner, {
      ...outlook(source, "GONE"),
      object: { type: "connection", connectionId: mail.id },
    });
    await admin.api.permissions.revoke(revoked);
    await serverBuilt(source, 1);
    await owner.api.screens.call(source, "addNote", ["Only the source's"]);
    await share(owner, source, maker, "user");
    await owner.api.apps.blueprints.mark(source, 1);

    await expect(maker.api.apps.blueprints.list()).resolves.toContainEqual(
      expect.objectContaining({ app: source, version: 1 })
    );
    const made: CreatedFromBlueprint[] = [];
    const events = await auditedDuring(async () => {
      made.push(await maker.api.apps.blueprints.create(source, 1, named));
    });
    const [created] = made;
    if (!created) {
      throw new Error("Nothing was created");
    }
    const { app, version, permissions, dropped } = created;

    expect({
      app,
      version,
      dropped: dropped.toSorted((a, b) => a.binding.localeCompare(b.binding)),
    }).toMatchObject({
      app: {
        name: "My notes",
        description: "Mine",
        owner: maker.userId,
        blueprint: `${source}@1`,
        currentVersion: null,
      },
      version: { version: 1, parent: null, author: maker.userId },
      dropped: [
        { connectionId: ghost, binding: "GHOST" },
        { connectionId: ownersMailbox, binding: "OWNERS" },
      ],
    });
    expect(
      permissions
        .map((permission) => ({
          subject: permission.subject,
          object: permission.object,
          binding: permission.binding,
          status: permission.status,
          requestedBy: permission.requestedBy,
          grantedBy: permission.grantedBy,
          grantedAt: permission.grantedAt,
        }))
        .toSorted((a, b) => a.binding.localeCompare(b.binding))
    ).toStrictEqual(
      [
        [{ type: "connection", connectionId: mail.id }, "MAIL"],
        [{ type: "connection", connectionId: makersMailbox }, "MAKERS"],
        [{ type: "connection", connectionId: other.id }, "OTHER"],
        // Its own workflow is the new App's.
        [{ type: "workflow", appId: app.id, workflowId: "report" }, "REPORT"],
      ].map(([object, binding]) => ({
        subject: { type: "app", appId: app.id },
        object,
        binding,
        // Requests, never grants, even of what was granted.
        status: "requested",
        requestedBy: maker.userId,
        grantedBy: null,
        grantedAt: null,
      }))
    );
    expect(
      events.map(({ action, target, detail }) => [
        action,
        target?.id,
        detail.connectionId ?? null,
      ])
    ).toStrictEqual([
      ["app.created", app.id, null],
      ["app.committed", app.id, null],
      ...permissions.map(({ id, object }) => [
        "permission.requested",
        id,
        object.type === "connection" ? object.connectionId : null,
      ]),
      ...dropped.map(({ connectionId }) => [
        "app.blueprint.connection_dropped",
        app.id,
        connectionId,
      ]),
    ]);

    // The same code and none of the data: the new App starts empty, and
    // shared with nobody.
    // Activated once the check passed: theirs to find and use.
    const theirs = await maker.api.apps.list();
    await maker.api.apps.versions.setCurrent(app.id, 1);
    await serverBuilt(app.id, 1);
    const { name: sourceName } = await owner.api.apps.get(source);
    expect({
      listed: theirs.some(({ id }) => id === app.id),
      files: await maker.api.apps.files.read(app.id, 1),
      notes: await maker.api.screens.call(app.id, "notes", []),
      members: await maker.api.apps.members.list(app.id),
      forOwner: await outcome(owner.api.apps.get(app.id)),
    }).toStrictEqual({
      listed: true,
      // The same code, but for AGENTS.md: the source's agents wrote it
      // from what the source read, which the copy has no sources for.
      files: {
        ...v1,
        "AGENTS.md": `Created from the blueprint of ${sourceName}, version 1. Write what this App does here.\n`,
      },
      notes: [],
      members: [],
      forOwner: "app.not_found",
    });
  });

  it("come only from a marked version, for those with a role in the App who build", async () => {
    const [owner, builder, user, outsider] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
      personApi("builder"),
    ]);
    const source = await notesApp(owner);
    await share(owner, source, builder, "builder");
    await share(owner, source, user, "user");
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();

    let marks: string[] = [];
    const events = await auditedDuring(async () => {
      marks = [
        await outcome(staff.apps.blueprints.mark(source, 1)),
        await outcome(staff.apps.blueprints.unmark(source, 1)),
        await outcome(user.api.apps.blueprints.mark(source, 1)),
        await outcome(builder.api.apps.blueprints.mark(source, 9)),
        await outcome(builder.api.apps.blueprints.mark(source, 1)),
        // Marking it again changes and records nothing.
        await outcome(owner.api.apps.blueprints.mark(source, 1)),
      ];
    });
    expect(marks).toStrictEqual([
      // Grasp staff don't decide which of a client's Apps get copied.
      "role.forbidden",
      "role.forbidden",
      "role.forbidden",
      "app.version_not_found",
      "ok",
      "ok",
    ]);
    await expect(
      Promise.all([
        outcome(owner.api.apps.blueprints.create(source, 2, named)),
        outcome(outsider.api.apps.blueprints.create(source, 1, named)),
        outcome(user.api.apps.blueprints.create(source, 1, named)),
        outcome(staff.apps.blueprints.create(source, 1, named)),
        outcome(builder.api.apps.blueprints.create(source, 1, { name: " " })),
      ])
    ).resolves.toStrictEqual([
      "app.blueprint_not_found",
      "app.not_found",
      // The organization's users don't create Apps.
      "role.forbidden",
      "role.forbidden",
      "app.invalid",
    ]);
    await expect(
      outsider.api.apps.blueprints.list()
    ).resolves.not.toContainEqual(expect.objectContaining({ app: source }));

    const unmarked = await auditedDuring(async () => {
      await owner.api.apps.blueprints.unmark(source, 1);
      await owner.api.apps.blueprints.unmark(source, 1);
    });
    const listed = await builder.api.apps.blueprints.list();
    expect({
      create: await outcome(
        builder.api.apps.blueprints.create(source, 1, named)
      ),
      listed: listed.some(({ app }) => app === source),
    }).toStrictEqual({ create: "app.blueprint_not_found", listed: false });
    expect(
      [...events, ...unmarked].map(({ actor, action, detail }) => ({
        actor,
        action,
        detail,
      }))
    ).toStrictEqual([
      {
        actor: { type: "person", userId: builder.userId },
        action: "app.blueprint.marked",
        detail: { version: 1 },
      },
      {
        actor: { type: "person", userId: owner.userId },
        action: "app.blueprint.unmarked",
        detail: { version: 1 },
      },
    ]);
  });

  it("aren't copied from a version unmarked while it was being copied", async () => {
    const owner = await personApi("builder");
    const source = await notesApp(owner);
    await owner.api.apps.blueprints.mark(source, 1);
    const by = await owner.api.whoami();
    // The version unmarked just before the batch that creates the App lands.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare("DELETE FROM app_blueprints WHERE app_id = ?")
          .bind(source)
          .run()
    );

    const refused = await outcome(
      createFromBlueprint({ ...env, DB: racing }, by, source, 1, {
        name: `Raced ${unique()}`,
      })
    );
    const apps = await owner.api.apps.list();
    expect({
      refused,
      created: apps.some(({ name }) => name.startsWith("Raced")),
    }).toStrictEqual({ refused: "app.blueprint_not_found", created: false });
  });

  it("aren't copied by someone the App was unshared with while it was being copied", async () => {
    const owner = await personApi("builder");
    const maker = await personApi("builder");
    const source = await notesApp(owner);
    await share(owner, source, maker, "user");
    await owner.api.apps.blueprints.mark(source, 1);
    const by = await maker.api.whoami();
    // Unshared just before the batch that creates the App lands.
    const racing = racingDb(
      async (db) =>
        await db
          .prepare("DELETE FROM app_members WHERE app_id = ? AND member_id = ?")
          .bind(source, maker.userId)
          .run()
    );

    const refused = await outcome(
      createFromBlueprint({ ...env, DB: racing }, by, source, 1, {
        name: `Unshared ${unique()}`,
      })
    );
    const created = await env.DB.prepare(
      "SELECT count(*) AS count FROM apps WHERE owner_id = ?"
    )
      .bind(maker.userId)
      .first<{ count: number }>();
    expect({ refused, created: created?.count }).toStrictEqual({
      refused: "app.not_found",
      created: 0,
    });
  });

  it("are taken back when the App read what the caller can't while it was being copied", async () => {
    const owner = await personApi("builder");
    const maker = await personApi("builder");
    const source = await notesApp(owner);
    await share(owner, source, maker, "user");
    await owner.api.apps.blueprints.mark(source, 1);
    const by = await maker.api.whoami();
    const mailbox = await mailboxOf(owner);
    // The owner's mailbox granted to the App just before the batch that
    // creates the copy lands, once: the copy's taking back is a batch too.
    let granted = false;
    const racing = racingDb(async () => {
      if (!granted) {
        granted = true;
        await storedGrant(
          { type: "app", id: source },
          { type: "connection", id: mailbox },
          ["mail.list"],
          "MAILBOX"
        );
      }
    });

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(
        createFromBlueprint({ ...env, DB: racing }, by, source, 1, {
          name: `Unreadable ${unique()}`,
        })
      );
    });
    const owned = await env.DB.prepare(
      "SELECT count(*) AS count FROM apps WHERE owner_id = ?"
    )
      .bind(maker.userId)
      .first<{ count: number }>();
    const revoked = events.find(
      ({ action }) => action === "app.blueprint.revoked"
    );
    expect({
      refused,
      owned: owned?.count,
      revoked: revoked?.detail,
    }).toStrictEqual({
      refused: "app.unreadable",
      owned: 0,
      revoked: { fromApp: source, reason: "app.unreadable" },
    });
  });

  it("leave no usable copy when the check after the copy fails without a reason", async () => {
    const owner = await personApi("builder");
    const maker = await personApi("builder");
    const source = await notesApp(owner);
    const mail = await mailConnection();
    await storedGrant(
      { type: "app", id: source },
      { type: "connection", id: mail.id },
      ["mail.list"],
      "MAIL"
    );
    await share(owner, source, maker, "user");
    await owner.api.apps.blueprints.mark(source, 1);
    const by = await maker.api.whoami();
    // Connect goes down once the copy's batch has landed, so the check
    // after it fails with no code of ours.
    let landed = false;
    const racing = racingDb(() => {
      landed = true;
    });
    const down = new Proxy(env.CONNECT, {
      get: (target, property) => {
        if (property === "connectionOwners" && landed) {
          return async () => {
            await Promise.reject(new Error("connect is down"));
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });

    const refused = await outcome(
      createFromBlueprint(
        { ...env, DB: racing, CONNECT: down },
        by,
        source,
        1,
        {
          name: `Unchecked ${unique()}`,
        }
      )
    );
    const owned = await env.DB.prepare(
      "SELECT count(*) AS count FROM apps WHERE owner_id = ?"
    )
      .bind(maker.userId)
      .first<{ count: number }>();
    expect({ refused: refused === "ok", owned: owned?.count }).toStrictEqual({
      refused: false,
      owned: 0,
    });
  });

  it("leave a copy pending and invisible when it can't be taken back, until the cron deletes it", async () => {
    const owner = await personApi("builder");
    const maker = await personApi("builder");
    const source = await notesApp(owner);
    await share(owner, source, maker, "user");
    await owner.api.apps.blueprints.mark(source, 1);
    const by = await maker.api.whoami();
    const mailbox = await mailboxOf(owner);
    // The source reads the owner's mailbox by the time the copy lands, and
    // the batch that would take the copy back fails.
    let batches = 0;
    const racing = racingDb(async () => {
      batches += 1;
      if (batches === 1) {
        await storedGrant(
          { type: "app", id: source },
          { type: "connection", id: mailbox },
          ["mail.list"],
          "MAILBOX"
        );
        return;
      }
      throw new Error("The database is out of reach");
    });

    const refused = await outcome(
      createFromBlueprint({ ...env, DB: racing }, by, source, 1, {
        name: `Stuck ${unique()}`,
      })
    );
    const stuck = await env.DB.prepare(
      "SELECT id, pending_since AS pendingSince FROM apps WHERE owner_id = ?"
    )
      .bind(maker.userId)
      .first<{ id: string; pendingSince: number | null }>();
    const listed = await maker.api.apps.list();
    const seen = {
      refused,
      pending: stuck?.pendingSince !== null,
      listed: listed.some(({ id }) => id === stuck?.id),
      opens: await outcome(maker.api.apps.get(stuck?.id ?? "")),
    };
    // Left pending past the hour the cron trigger allows.
    await env.DB.prepare("UPDATE apps SET pending_since = ? WHERE id = ?")
      .bind(Date.now() - 2 * 60 * 60 * 1000, stuck?.id ?? "")
      .run();
    const events = await auditedDuring(async () => {
      await runCron();
    });
    const left = await env.DB.prepare(
      "SELECT count(*) AS count FROM apps WHERE owner_id = ?"
    )
      .bind(maker.userId)
      .first<{ count: number }>();
    expect({
      seen,
      left: left?.count,
      swept: events.find(
        ({ action, target }) =>
          action === "app.blueprint.revoked" && target?.id === stuck?.id
      )?.detail,
    }).toStrictEqual({
      seen: {
        refused: "app.unreadable",
        pending: true,
        listed: false,
        opens: "app.not_found",
      },
      left: 0,
      swept: { blueprint: `${source}@1`, reason: "pending_expired" },
    });
  });

  it("are listed newest first", async () => {
    const owner = await personApi("builder");
    const source = await notesApp(owner);
    await owner.api.apps.blueprints.mark(source, 2);
    await owner.api.apps.blueprints.mark(source, 1);
    // Version 2 marked a second before version 1, so what orders them is
    // when they were marked, not the newer version first.
    await env.DB.prepare(
      "UPDATE app_blueprints SET marked_at = marked_at - 1000 WHERE app_id = ? AND version = 2"
    )
      .bind(source)
      .run();

    const listed = await owner.api.apps.blueprints.list();
    expect(
      listed.filter(({ app }) => app === source).map(({ version }) => version)
    ).toStrictEqual([1, 2]);
  });
});
