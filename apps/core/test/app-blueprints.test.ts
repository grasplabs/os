import type { CreatedFromBlueprint } from "@grasp-os/shared/apps";
import type { Role } from "@grasp-os/shared/roles";
import { describe, expect, it } from "vite-plus/test";

import { outlook, release, requestGranted, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { mailConnection } from "./mail-connection.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Blueprints: a builder marks a version of an App as a blueprint, and
// whoever has a role in the App and builds creates an App of their own
// from it: the same code, none of the data, and requests for what the App
// was given. The ways this could go wrong, tried below: data, settings or
// people coming along, a grant coming along instead of a request, a
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

const v1 = {
  "app/server.ts": serverCode,
  "screens/notes.tsx": "export default () => <p>Notes</p>;\n",
  "AGENTS.md": "# Notes\n",
};

/** A released App of `owner`'s at version 1, with a version 2 after it. */
const notesApp = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Notes ${unique()}` });
  await release(owner, id, v1);
  await owner.api.apps.files.write(id, { "AGENTS.md": "# Notes, v2\n" });
  await owner.api.apps.files.commit(id, "Version 2");
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

describe("blueprints", () => {
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
    const { app, version, permissions } = created;

    expect({ app, version }).toMatchObject({
      app: {
        name: "My notes",
        description: "Mine",
        owner: maker.userId,
        blueprint: `${source}@1`,
        currentVersion: null,
      },
      version: { version: 1, parent: null, author: maker.userId },
    });
    expect(
      permissions.map(({ subject, object, binding, status, requestedBy }) => ({
        subject,
        object,
        binding,
        status,
        requestedBy,
      }))
    ).toStrictEqual(
      [
        [{ type: "connection", connectionId: mail.id }, "MAIL"],
        [{ type: "connection", connectionId: other.id }, "OTHER"],
        // Its own workflow is the new App's.
        [{ type: "workflow", appId: app.id, workflowId: "report" }, "REPORT"],
      ].map(([object, binding]) => ({
        subject: { type: "app", appId: app.id },
        object,
        binding,
        status: "requested",
        requestedBy: maker.userId,
      }))
    );
    expect(
      events.map(({ action, target }) => [action, target?.id])
    ).toStrictEqual([
      ["app.created", app.id],
      ["app.committed", app.id],
      ...permissions.map(({ id }) => ["permission.requested", id]),
    ]);

    // The same code and none of the data: the new App starts empty, and
    // shared with nobody.
    await maker.api.apps.versions.setCurrent(app.id, 1);
    await serverBuilt(app.id, 1);
    expect({
      files: await maker.api.apps.files.read(app.id, 1),
      notes: await maker.api.screens.call(app.id, "notes", []),
      members: await maker.api.apps.members.list(app.id),
      forOwner: await outcome(owner.api.apps.get(app.id)),
    }).toStrictEqual({
      // The same code.
      files: v1,
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
        await outcome(user.api.apps.blueprints.mark(source, 1)),
        await outcome(builder.api.apps.blueprints.mark(source, 9)),
        await outcome(builder.api.apps.blueprints.mark(source, 1)),
        // Marking it again changes and records nothing.
        await outcome(owner.api.apps.blueprints.mark(source, 1)),
      ];
    });
    expect(marks).toStrictEqual([
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
});
