import type { CreatedFromBlueprint } from "@grasp-os/shared/apps";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { createFromBlueprint } from "../src/app-blueprints.ts";
import { outlook, release, requestGranted, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  collectionWithNote,
  readCollection,
  storedGrant,
} from "./knowledge.ts";
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
// from it: the same code, none of the data, and requests for what the
// blueprint declares. The ways this could go wrong, tried below: data,
// settings or people coming along (the source's AGENTS.md too), a grant
// coming along instead of a request, a request naming a connection or
// another App the creator may not see, a blueprint made of a version
// nobody marked, someone without a role in the App (or who doesn't build,
// or staff) copying it, and a change nobody recorded.

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

// The test of the same code builds the server code of two Apps, the source and the
// copy, one after the other (the build cache keys builds by App, so the
// copy's can't reuse the source's), and calls each once. That is the
// point of it: the copy runs the same code with none of the data. On its
// own it takes about 1.5 seconds, but on a loaded runner the two builds
// pushed it past the default five. Nothing polls or sleeps: the only
// deadlines are the two calls' ten seconds each (`APP_CALL_TIMEOUT_MS`),
// which end a call that hangs. Sixty seconds is room for a slow runner,
// as the other tests that release Apps give theirs.
describe("blueprints", { timeout: 60_000 }, () => {
  it("ask only for what the blueprint declares as it is marked: never a grant, a connection, or another App", async () => {
    const [owner, maker] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const admin = await signedInApi(idp, "admin");
    const source = await notesApp(owner);
    const hidden = await notesApp(owner);
    const [{ collectionId: handbook }, { collectionId: later }] =
      await Promise.all([
        collectionWithNote(admin.api, {
          name: `Handbook ${unique()}`,
          access: "everyone",
        }),
        collectionWithNote(admin.api, {
          name: `Later ${unique()}`,
          access: "everyone",
        }),
      ]);
    const [mail, mailbox] = await Promise.all([
      mailConnection(),
      mailboxOf(owner),
    ]);
    // Granted, and asked for: the collection is declared, the rest not.
    await requestGranted(
      idp,
      owner,
      readCollection({ type: "app", appId: source }, handbook)
    );
    await requestGranted(idp, owner, {
      ...outlook(source, "MAIL"),
      object: { type: "connection", connectionId: mail.id },
    });
    const asked: PermissionRequest[] = [
      {
        ...outlook(source, "MAILBOX"),
        object: { type: "connection", connectionId: mailbox },
      },
      {
        subject: { type: "app", appId: source },
        object: { type: "workflow", appId: source, workflowId: "report" },
        actions: ["start"],
        binding: "REPORT",
      },
      {
        subject: { type: "app", appId: source },
        object: { type: "workflow", appId: hidden, workflowId: "report" },
        actions: ["start"],
        binding: "HIDDEN_FLOW",
      },
      {
        subject: { type: "app", appId: source },
        object: { type: "app", appId: hidden },
        actions: ["read"],
        binding: "HIDDEN_CRM",
      },
    ];
    for (const request of asked) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      await owner.api.permissions.request(request);
    }
    await share(owner, source, maker, "user");
    const { id: blueprint } = await owner.api.apps.blueprints.mark(source, 1);
    // Asked for after the version was marked: not declared.
    await owner.api.permissions.request(
      readCollection({ type: "app", appId: source }, later, "LATER")
    );

    const listed = await maker.api.apps.blueprints.list();
    const created = await maker.api.apps.blueprints.create(blueprint, named);
    const theirs = await maker.api.permissions.list({
      type: "app",
      appId: created.app.id,
    });

    const declared = {
      object: { type: "collection", collectionId: handbook },
      actions: ["read"],
      binding: "HANDBOOK",
    };
    expect({
      declared: listed.find(({ app }) => app === source)?.permissions,
      asked: created.permissions.map(
        ({
          subject,
          object,
          actions,
          binding,
          status,
          requestedBy,
          grantedBy,
        }) => ({
          subject,
          object,
          actions,
          binding,
          status,
          requestedBy,
          grantedBy,
        })
      ),
      // Nothing it answers or lists names another App or a connection.
      names: [hidden, mail.id, mailbox].filter(
        (id) =>
          JSON.stringify(created).includes(id) ||
          JSON.stringify(theirs).includes(id)
      ),
    }).toStrictEqual({
      declared: [declared],
      asked: [
        {
          subject: { type: "app", appId: created.app.id },
          ...declared,
          // A request, never a grant, even of what was granted.
          status: "requested",
          requestedBy: maker.userId,
          grantedBy: null,
        },
      ],
      names: [],
    });
  });

  it("create an App with the same code and none of the data, audited", async () => {
    const [owner, maker, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const source = await notesApp(owner);
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Handbook ${unique()}`,
      access: "everyone",
    });
    await owner.api.permissions.request(
      readCollection({ type: "app", appId: source }, collectionId)
    );
    await serverBuilt(source, 1);
    await owner.api.screens.call(source, "addNote", ["Only the source's"]);
    await share(owner, source, maker, "user");
    const { id: blueprint } = await owner.api.apps.blueprints.mark(source, 1);

    await expect(maker.api.apps.blueprints.list()).resolves.toContainEqual(
      expect.objectContaining({ id: blueprint, app: source, version: 1 })
    );
    const made: CreatedFromBlueprint[] = [];
    const events = await auditedDuring(async () => {
      made.push(await maker.api.apps.blueprints.create(blueprint, named));
    });
    const [created] = made;
    if (!created) {
      throw new Error("Nothing was created");
    }
    const { app, version, permissions } = created;

    expect({ app, version }).toMatchObject({
      app: {
        name: "My notes",
        description: "Mine",
        owner: maker.userId,
        blueprint,
        currentVersion: null,
      },
      version: { version: 1, parent: null, author: maker.userId },
    });
    expect(
      events.map(({ action, target, detail }) => [
        action,
        target?.id,
        detail.blueprint ?? null,
      ])
    ).toStrictEqual([
      ["app.created", app.id, blueprint],
      ["app.committed", app.id, null],
      ...permissions.map(({ id }) => ["permission.requested", id, blueprint]),
    ]);

    // The same code and none of the data: the new App starts empty, and
    // shared with nobody.
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
        "AGENTS.md": `Created from the blueprint ${sourceName}. Write what this App does here.\n`,
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
    let id = "";
    const events = await auditedDuring(async () => {
      marks = [
        // Grasp staff don't decide which of a client's Apps get copied.
        await outcome(staff.apps.blueprints.mark(source, 1)),
        await outcome(user.api.apps.blueprints.mark(source, 1)),
        await outcome(builder.api.apps.blueprints.mark(source, 9)),
      ];
      ({ id } = await builder.api.apps.blueprints.mark(source, 1));
      // Marking it again changes and records nothing.
      const again = await owner.api.apps.blueprints.mark(source, 1);
      marks.push(
        again.id === id ? "same" : "another",
        await outcome(staff.apps.blueprints.unmark(id)),
        await outcome(user.api.apps.blueprints.unmark(id))
      );
    });
    expect(marks).toStrictEqual([
      "role.forbidden",
      "role.forbidden",
      "app.version_not_found",
      "same",
      "role.forbidden",
      "role.forbidden",
    ]);
    await expect(
      Promise.all([
        outcome(owner.api.apps.blueprints.create(`${id}-not`, named)),
        outcome(outsider.api.apps.blueprints.create(id, named)),
        outcome(user.api.apps.blueprints.create(id, named)),
        outcome(staff.apps.blueprints.create(id, named)),
        outcome(builder.api.apps.blueprints.create(id, { name: " " })),
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
      await owner.api.apps.blueprints.unmark(id);
      await owner.api.apps.blueprints.unmark(id);
    });
    const listed = await builder.api.apps.blueprints.list();
    expect({
      create: await outcome(builder.api.apps.blueprints.create(id, named)),
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
        detail: { version: 1, blueprint: id },
      },
      {
        actor: { type: "person", userId: owner.userId },
        action: "app.blueprint.unmarked",
        detail: { version: 1, blueprint: id },
      },
    ]);
  });

  it("aren't copied from a version unmarked while it was being copied", async () => {
    const owner = await personApi("builder");
    const source = await notesApp(owner);
    const { id } = await owner.api.apps.blueprints.mark(source, 1);
    const by = await owner.api.whoami();
    // Unmarked just before the batch that creates the App lands.
    const racing = racingDb(
      async (db) =>
        await db.prepare("DELETE FROM blueprints WHERE id = ?").bind(id).run()
    );

    const refused = await outcome(
      createFromBlueprint({ ...env, DB: racing }, by, id, {
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
    const { id } = await owner.api.apps.blueprints.mark(source, 1);
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
      createFromBlueprint({ ...env, DB: racing }, by, id, {
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

  it("aren't copied by someone who can't read what the App read, and gain nothing from a read raced in after the check", async () => {
    const owner = await personApi("builder");
    const maker = await personApi("builder");
    const [unreadable, raced] = await Promise.all([
      notesApp(owner),
      notesApp(owner),
    ]);
    const marked: string[] = [];
    for (const source of [unreadable, raced]) {
      // oxlint-disable-next-line no-await-in-loop -- two, one at a time
      await share(owner, source, maker, "user");
      // oxlint-disable-next-line no-await-in-loop -- two, one at a time
      const { id } = await owner.api.apps.blueprints.mark(source, 1);
      marked.push(id);
    }
    const [unreadableBlueprint = "", racedBlueprint = ""] = marked;
    const mailbox = await mailboxOf(owner);
    const readsMailbox = async (app: string): Promise<void> => {
      await storedGrant(
        { type: "app", id: app },
        { type: "connection", id: mailbox },
        ["mail.list"],
        "MAILBOX"
      );
    };
    await readsMailbox(unreadable);
    const by = await maker.api.whoami();
    // The other App granted the owner's mailbox just before the batch that
    // creates its copy lands, once: after the check, which it passed.
    let granted = false;
    const racing = racingDb(async () => {
      if (!granted) {
        granted = true;
        await readsMailbox(raced);
      }
    });

    const refused = await outcome(
      maker.api.apps.blueprints.create(unreadableBlueprint, named)
    );
    const copy = await createFromBlueprint(
      { ...env, DB: racing },
      by,
      racedBlueprint,
      named
    );
    const owned = await env.DB.prepare("SELECT id FROM apps WHERE owner_id = ?")
      .bind(maker.userId)
      .all<{ id: string }>();
    expect({
      refused,
      owned: owned.results.map(({ id }) => id),
      // Neither the mailbox nor a request for it: the copy asks only for
      // what the blueprint declared as it was marked.
      permissions: await maker.api.permissions.list({
        type: "app",
        appId: copy.app.id,
      }),
    }).toStrictEqual({
      refused: "app.unreadable",
      owned: [copy.app.id],
      permissions: [],
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
      "UPDATE blueprints SET marked_at = marked_at - 1000 WHERE app_id = ? AND version = 2"
    )
      .bind(source)
      .run();

    const listed = await owner.api.apps.blueprints.list();
    expect(
      listed.filter(({ app }) => app === source).map(({ version }) => version)
    ).toStrictEqual([1, 2]);
  });
});
