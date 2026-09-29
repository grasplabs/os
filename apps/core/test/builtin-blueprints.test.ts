import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import type { DeclaredPermission } from "@grasp-os/shared/permissions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { BuiltinBlueprint } from "#blueprints";

import { installBuiltinBlueprint } from "../src/app-blueprints.ts";
import { builtinAppId } from "../src/builtin-app-id.ts";
import {
  builtins,
  fingerprintOf,
  installBuiltins,
  release,
} from "../src/builtins.ts";
import type { Release } from "../src/builtins.ts";
import { buildScreens } from "../src/screens.ts";
import { grantReviewed, racingDb, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote } from "./knowledge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedInApi,
  unique,
} from "./sign-in.ts";

// The built-in blueprints: Apps' blueprints that ship with each release,
// installed on the first request (src/builtins.ts) through the App
// registry (src/app-blueprints.ts). These tests start from the ways that
// can fail: a built-in isn't listed, or can't be created from, as any
// blueprint is; a changed release doesn't reach it, writes it twice when
// two installs race, or changes an App already created from it; an
// unchanged release writes again; a failure halfway is recorded as done;
// someone who builds can't find or copy it, a user can, or anyone, an
// admin too, changes, runs, shares, asks permissions for it, or grants
// or revokes its own; a copy doesn't ask for what the release declares,
// keeps asking once it no longer does, or asks twice when two installs
// race; a declaration reordered is written again, or one changed under
// its binding leaves two live requests; and a built-in the release ships
// doesn't build.
//
// The global setup embeds the tests' own built-in, `hello`
// (test/fixtures/blueprints/), with the release's. The tests of a file
// share their storage, so each test that changes the built-in starts from
// the release, installed again, and ends by installing it again.

const idp = mockIdp();

const hello = (): BuiltinBlueprint => {
  const found = release.blueprints.find(({ id }) => id === "hello");
  if (!found) {
    throw new Error("The global setup didn't embed the tests' built-in");
  }
  return found;
};

const helloApp = builtinAppId("hello");

/** The singleton's install, asked for by an isolate of this release. */
const ensureInstalled = async (): Promise<boolean> =>
  await builtins(env).ensureInstalled(await fingerprintOf(env, release));

/** This release, with `hello` changed as `change` says: another release. */
const releaseWith = (change: Partial<BuiltinBlueprint>): Release => ({
  ...release,
  blueprints: release.blueprints.map((blueprint) =>
    blueprint.id === "hello" ? { ...blueprint, ...change } : blueprint
  ),
});

/** A release whose `hello` greets differently. */
const changedHello = (): Release =>
  releaseWith({
    files: {
      ...hello().files,
      "app/server.ts": `${hello().files["app/server.ts"]}\n// Changed.\n`,
    },
  });

/** Installs `of` as the singleton would, whatever it installed before. */
const install = async (of: Release, coreEnv: Env = env): Promise<boolean> =>
  await runInDurableObject(builtins(env), async (_instance, state) => {
    await state.storage.delete("installed");
    return await installBuiltins(coreEnv, state.storage, of);
  });

/** The release's built-ins, installed again. */
const reinstall = async (): Promise<void> => {
  await expect(install(release)).resolves.toBeTruthy();
};

/** `hello`'s versions, and which of them is marked. */
const helloState = async (): Promise<{
  versions: number[];
  marked: number[];
}> => {
  const versionsIn = async (table: string): Promise<number[]> => {
    const { results } = await env.DB.prepare(
      `SELECT version FROM ${table} WHERE app_id = ? ORDER BY version`
    )
      .bind(helloApp)
      .all<{ version: number }>();
    return results.map(({ version }) => version);
  };
  return {
    versions: await versionsIn("app_versions"),
    marked: await versionsIn("app_blueprints"),
  };
};

const appActions = (events: { action: string; target?: { id: string } }[]) =>
  events
    .filter(({ target }) => target?.id === helloApp)
    .map(({ action }) => action);

/** A permission to read and write the collection `collectionId`. */
const notesOf = (collectionId: CollectionId): DeclaredPermission => ({
  object: { type: "collection", collectionId },
  actions: ["read", "write"],
  binding: "NOTES",
});

/** `hello`'s permissions (only those not revoked, with `live`), oldest first. */
const helloRequests = async (live = false) => {
  const { results } = await env.DB.prepare(
    `SELECT binding, status, requested_by AS requestedBy, revoked_by AS revokedBy
     FROM permissions WHERE subject_id = ? ${live ? "AND status <> 'revoked'" : ""}
     ORDER BY requested_at`
  )
    .bind(helloApp)
    .all();
  return results;
};

/** The permission changes of `hello` in `events`, and who made them. */
const permissionEvents = (events: Awaited<ReturnType<typeof auditedDuring>>) =>
  events
    .filter(({ detail }) => detail?.subjectId === helloApp)
    .map(({ action, actor }) => [action, actor.type]);

const insertsVersion = /^insert into "app_versions"/iu;
const insertsPermission = /^insert into "permissions"/iu;

/** `racingDb`, racing the batch that writes an App version by default. */
const dbRacing = (
  first: () => Promise<unknown>,
  writes: RegExp = insertsVersion
): D1Database => racingDb(first, writes);

describe("the built-in blueprints", () => {
  it("are every folder under apps/core/blueprints, and the tests' own", () => {
    // Vite lists the folders at build time; the build embeds each one.
    const folders = Object.keys(
      import.meta.glob("../blueprints/*/blueprint.json")
    ).map((file) => file.split("/")[2] ?? file);
    expect(release.blueprints.map(({ id }) => id).toSorted()).toStrictEqual(
      [...folders, "hello"].toSorted()
    );
  });

  it("are an App's blueprints that everyone who builds finds and creates from, and users don't", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const builder = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");

    // Shared with nobody, and found by every builder all the same.
    const listed = await builder.api.apps.blueprints.list();
    const found = listed.find(({ app }) => app === helloApp);
    expect(
      found && [found.name, found.description, found.version, found.markedBy]
    ).toStrictEqual([hello().name, hello().description, 1, "grasp"]);

    const created = await builder.api.apps.blueprints.create(helloApp, 1, {
      name: "Our hello",
    });
    await builder.api.apps.versions.setCurrent(created.app.id, 1);
    await serverBuilt(created.app.id, 1);
    expect({
      blueprint: created.app.blueprint,
      owner: created.app.owner,
      permissions: created.permissions,
      files: await builder.api.apps.files.read(created.app.id, 1),
      greeting: await builder.api.screens.call(created.app.id, "hello", [
        "Ann",
      ]),
    }).toStrictEqual({
      blueprint: `${helloApp}@1`,
      owner: builder.userId,
      permissions: [],
      files: hello().files,
      greeting: "Hello, Ann: greeting 1",
    });

    // Users build no Apps: they neither find a built-in nor create from one.
    await expect(
      Promise.all([
        outcome(user.api.apps.get(helloApp)),
        outcome(user.api.apps.blueprints.create(helloApp, 1, { name: "Mine" })),
      ])
    ).resolves.toStrictEqual(["app.not_found", "role.forbidden"]);
  });

  it("can't be changed, run, shared or given permissions, by an admin neither, whatever app_sharing says", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const changes = async (api: typeof admin.api) =>
      await Promise.all([
        outcome(api.apps.files.write(helloApp, { "notes.md": "# Mine\n" })),
        outcome(api.apps.files.commit(helloApp, "Mine")),
        outcome(api.apps.blueprints.mark(helloApp, 1)),
        outcome(api.apps.blueprints.unmark(helloApp, 1)),
        outcome(api.apps.versions.setCurrent(helloApp, 1)),
        outcome(
          api.apps.members.add(helloApp, {
            type: "person",
            id: builder.userId,
            role: "builder",
          })
        ),
        outcome(
          api.permissions.request({
            subject: { type: "app", appId: helloApp },
            object: { type: "connection", connectionId: "connection-outlook" },
            actions: ["mail.list"],
            binding: "OUTLOOK",
          })
        ),
      ]);
    const refused = Array.from({ length: 7 }, () => "role.forbidden");

    const before = await helloState();
    await expect(changes(admin.api)).resolves.toStrictEqual(refused);

    // With app_sharing off (and so blueprints too), every builder may build
    // every App, but still not a built-in, which they still find.
    const off: Env = { ...env, FEATURES: { apps: true, permissions: true } };
    const { core } = await openRpc(admin.session, { coreEnv: off });
    const offAdmin = core.authenticate();
    const { core: builderCore } = await openRpc(builder.session, {
      coreEnv: off,
    });
    const listedOff = await builderCore.authenticate().apps.list();
    expect({
      refused: await Promise.all([
        outcome(
          offAdmin.apps.files.write(helloApp, { "notes.md": "# Mine\n" })
        ),
        outcome(offAdmin.apps.files.commit(helloApp, "Mine")),
        outcome(offAdmin.apps.versions.setCurrent(helloApp, 1)),
      ]),
      listed: listedOff.some(({ id }) => id === helloApp),
    }).toStrictEqual({ refused: refused.slice(0, 3), listed: true });
    await expect(helloState()).resolves.toStrictEqual(before);

    // Nor does another App get to call its exports: a built-in never runs.
    const caller = await admin.api.apps.create({ name: `Caller ${unique()}` });
    await expect(
      outcome(
        admin.api.permissions.request({
          subject: { type: "app", appId: caller.id },
          object: { type: "app", appId: helloApp },
          actions: ["read"],
          binding: "HELLO",
        })
      )
    ).resolves.toBe("permission.invalid");
  });

  it("each create an App that builds", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const builder = await signedInApi(idp, "builder");
    for (const blueprint of release.blueprints) {
      const app = builtinAppId(blueprint.id);
      // oxlint-disable-next-line no-await-in-loop -- one at a time, as the install does
      const created = await builder.api.apps.blueprints.create(app, 1, {
        name: blueprint.name,
      });
      // Its workflows' tests run as it becomes current.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await builder.api.apps.versions.setCurrent(created.app.id, 1);
      if ("app/server.ts" in blueprint.files) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await serverBuilt(created.app.id, 1);
      }
      // Its screens pass the compiler's checks, as they do when opened.
      if (
        Object.keys(blueprint.files).some((path) => path.startsWith("screens/"))
      ) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        const screens = await buildScreens(env, { ...blueprint.files });
        if (!screens.ok || screens.diagnostics.length > 0) {
          throw new Error(
            `The screens of ${blueprint.id} don't pass: ${JSON.stringify(screens.diagnostics)}`
          );
        }
      }
    }
  });

  it("take a changed release as a new version once, and leave Apps created from them alone", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const admin = await signedInApi(idp, "admin");
    const before = await helloState();
    const created = await admin.api.apps.blueprints.create(
      helloApp,
      before.versions.at(-1) ?? 1,
      { name: "Kept" }
    );

    const events = await auditedDuring(async () => {
      await expect(install(changedHello())).resolves.toBeTruthy();
      // Installed again with nothing changed: nothing more is written.
      await expect(install(changedHello())).resolves.toBeTruthy();
    });
    const next = (before.versions.at(-1) ?? 0) + 1;
    await expect(helloState()).resolves.toStrictEqual({
      versions: [...before.versions, next],
      marked: [next],
    });
    expect(appActions(events)).toStrictEqual([
      "app.committed",
      "app.blueprint.marked",
      "app.blueprint.unmarked",
    ]);
    await expect(
      admin.api.apps.files.read(created.app.id, 1)
    ).resolves.toStrictEqual(hello().files);

    await reinstall();
  });

  it("take a changed name and description, audited", async () => {
    const admin = await signedInApi(idp, "admin");
    await reinstall();
    const events = await auditedDuring(async () => {
      await expect(
        install(releaseWith({ name: "Hi", description: "Says hi." }))
      ).resolves.toBeTruthy();
    });
    const listed = await admin.api.apps.blueprints.list();
    expect({
      listed: listed
        .filter(({ app }) => app === helloApp)
        .map(({ name, description }) => [name, description]),
      audited: appActions(events),
    }).toStrictEqual({
      listed: [["Hi", "Says hi."]],
      audited: ["app.described"],
    });

    await reinstall();
  });

  it("create the collections they declare once, open to everyone and changed by admins only", async () => {
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const id = collectionIdSchema.parse(`greetings-${unique()}`);
    const declared = releaseWith({
      collections: [{ id, name: "Greetings", description: "Said hello." }],
    });
    // Not while record types are off: nothing would keep records there.
    const off: Env = {
      ...env,
      FEATURES: {
        ...z.record(z.string(), z.boolean()).parse(env.FEATURES),
        record_types: false,
      },
    };
    await expect(install(declared, off)).resolves.toBeTruthy();
    const whileOff = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS count FROM collections WHERE id = ?"
    )
      .bind(id)
      .first<{ count: number }>();
    const events = await auditedDuring(async () => {
      await expect(install(declared)).resolves.toBeTruthy();
      await expect(install(declared)).resolves.toBeTruthy();
    });
    const collection = await env.KNOWLEDGE.prepare(
      "SELECT name, owner, access, source FROM collections WHERE id = ?"
    )
      .bind(id)
      .first();
    const save = async (person: typeof admin) =>
      await outcome(
        person.api.knowledge.saveDocument({
          collectionId: id,
          path: `hello-${unique()}.md`,
          text: "# Hello",
          ifVersion: 0,
        })
      );
    expect({
      whileOff: whileOff?.count,
      collection,
      created: events.filter(
        ({ action, target }) =>
          action === "knowledge.collection.created" && target?.id === id
      ).length,
      admin: await save(admin),
      builder: await save(builder),
    }).toStrictEqual({
      whileOff: 0,
      collection: {
        name: "Greetings",
        owner: "grasp",
        access: "everyone",
        source: "here",
      },
      created: 1,
      admin: "ok",
      builder: "knowledge.forbidden",
    });

    await reinstall();
  });

  it("are written once when two installs race for the same version", async () => {
    await reinstall();
    const before = await helloState();
    const changed = changedHello().blueprints.find(({ id }) => id === "hello");
    if (!changed) {
      throw new Error("There's no changed hello");
    }

    const events = await auditedDuring(async () => {
      const racing: Env = {
        ...env,
        DB: dbRacing(async () => {
          await installBuiltinBlueprint(env, changed);
        }),
      };
      // The other install wrote the version first: this one is refused,
      // and writes nothing.
      await expect(
        outcome(installBuiltinBlueprint(racing, changed))
      ).resolves.not.toBe("ok");
    });
    const next = (before.versions.at(-1) ?? 0) + 1;
    await expect(helloState()).resolves.toStrictEqual({
      versions: [...before.versions, next],
      marked: [next],
    });
    expect(appActions(events)).toStrictEqual([
      "app.committed",
      "app.blueprint.marked",
      "app.blueprint.unmarked",
    ]);

    await reinstall();
  });

  it("aren't recorded as installed after a failure halfway, and the next install finishes", async () => {
    await reinstall();
    const before = await helloState();
    const down: Env = {
      ...env,
      DB: dbRacing(() => {
        throw new Error("D1 unavailable");
      }),
    };

    await expect(install(changedHello(), down)).resolves.toBeFalsy();
    const stamped = await runInDurableObject(
      builtins(env),
      async (_instance, state) => await state.storage.get("installed")
    );
    expect([stamped, await helloState()]).toStrictEqual([undefined, before]);

    await expect(install(changedHello())).resolves.toBeTruthy();
    const next = (before.versions.at(-1) ?? 0) + 1;
    await expect(helloState()).resolves.toStrictEqual({
      versions: [...before.versions, next],
      marked: [next],
    });

    await reinstall();
  });

  it("ask, in each App created from them, for what their release declares, and stop when it no longer does", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Declared ${unique()}`,
      access: "everyone",
    });
    const declared = notesOf(collectionId);
    const declaring = releaseWith({ permissions: [declared] });
    // Another release: every isolate installs it again.
    await expect(fingerprintOf(env, declaring)).resolves.not.toBe(
      await fingerprintOf(env, release)
    );
    const requested = await auditedDuring(async () => {
      await expect(install(declaring)).resolves.toBeTruthy();
      // Installed again: nothing more is written.
      await expect(install(declaring)).resolves.toBeTruthy();
    });
    expect({
      stored: await helloRequests(),
      audited: permissionEvents(requested),
    }).toStrictEqual({
      stored: [
        {
          binding: "NOTES",
          status: "requested",
          requestedBy: "grasp",
          revokedBy: null,
        },
      ],
      audited: [["permission.requested", "system"]],
    });

    // A copy asks for it, for an admin to grant, and gets it.
    const { versions } = await helloState();
    const created = await builder.api.apps.blueprints.create(
      helloApp,
      versions.at(-1) ?? 1,
      { name: "Asks" }
    );
    const [asked] = created.permissions;
    expect(created.permissions).toStrictEqual([
      expect.objectContaining({
        subject: { type: "app", appId: created.app.id },
        ...declared,
        status: "requested",
        requestedBy: builder.userId,
      }),
    ]);
    const granted = await grantReviewed(admin.api, asked?.id ?? "");

    // The built-in's own request is the release's: an admin neither grants
    // nor revokes it, so every copy keeps asking for it.
    const own = await env.DB.prepare(
      "SELECT id FROM permissions WHERE subject_id = ? AND status = 'requested'"
    )
      .bind(helloApp)
      .first<{ id: string }>();
    const refusedOwn = await Promise.all([
      outcome(grantReviewed(admin.api, own?.id ?? "")),
      outcome(admin.api.permissions.revoke(own?.id ?? "")),
    ]);
    const second = await builder.api.apps.blueprints.create(
      helloApp,
      versions.at(-1) ?? 1,
      { name: "Asks too" }
    );
    expect({
      refusedOwn,
      second: second.permissions.map(({ binding, status }) => [
        binding,
        status,
      ]),
    }).toStrictEqual({
      refusedOwn: ["permission.builtin", "permission.builtin"],
      second: [["NOTES", "requested"]],
    });

    // The release stops declaring it: the built-in's request is revoked,
    // the copy keeps what it was granted, and a new copy asks for nothing.
    const revoked = await auditedDuring(async () => {
      await expect(install(release)).resolves.toBeTruthy();
    });
    const later = await builder.api.apps.blueprints.create(
      helloApp,
      versions.at(-1) ?? 1,
      { name: "Asks nothing" }
    );
    expect({
      stored: await helloRequests(),
      audited: permissionEvents(revoked),
      copy: await admin.api.permissions.list({
        type: "app",
        appId: created.app.id,
      }),
      later: later.permissions,
    }).toStrictEqual({
      stored: [
        {
          binding: "NOTES",
          status: "revoked",
          requestedBy: "grasp",
          revokedBy: "grasp",
        },
      ],
      audited: [["permission.revoked", "system"]],
      copy: [granted],
      later: [],
    });
  });

  it("leave what a copy was granted as its builder makes its first version current and a release changes them, but not its next version or a rollback", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const builder = await signedInApi(idp, "builder");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Granted ${unique()}`,
      access: "everyone",
    });
    const declaring = releaseWith({ permissions: [notesOf(collectionId)] });
    await expect(install(declaring)).resolves.toBeTruthy();
    const { versions } = await helloState();
    const created = await builder.api.apps.blueprints.create(
      helloApp,
      versions.at(-1) ?? 1,
      { name: "Granted" }
    );
    const [asked] = created.permissions;
    const granted = await grantReviewed(admin.api, asked?.id ?? "");
    const copy = { type: "app", appId: created.app.id } as const;

    // Its first version is the blueprint's code, which the admin granted
    // it for; a new release changes the built-in, not the copy.
    const kept = await auditedDuring(async () => {
      await builder.api.apps.versions.setCurrent(created.app.id, 1);
      await expect(
        install(
          releaseWith({
            files: {
              ...hello().files,
              "app/server.ts": `${hello().files["app/server.ts"]}\n// Changed.\n`,
            },
            permissions: [notesOf(collectionId)],
          })
        )
      ).resolves.toBeTruthy();
    });
    const afterRelease = await admin.api.permissions.list(copy);

    // Code of the builder's own is asked for again.
    await builder.api.apps.files.write(created.app.id, {
      "app/server.ts": `${hello().files["app/server.ts"]}\n// Mine.\n`,
    });
    const { version } = await builder.api.apps.files.commit(
      created.app.id,
      "Mine"
    );
    await builder.api.apps.versions.setCurrent(created.app.id, version);
    const next = await admin.api.permissions.list(copy);

    // Granted again for the builder's code, then rolled back to the first
    // version by the builder: asked for again, as for any version but the
    // first one's first time.
    await grantReviewed(admin.api, asked?.id ?? "");
    await builder.api.apps.versions.setCurrent(created.app.id, 1);
    const rolledBack = await admin.api.permissions.list(copy);

    expect({
      audited: kept.filter(
        ({ action, detail }) =>
          action.startsWith("permission.") &&
          detail?.subjectId === created.app.id
      ),
      afterRelease,
      next: next.map(({ status, requestedBy }) => ({ status, requestedBy })),
      rolledBack: rolledBack.map(({ status }) => status),
    }).toStrictEqual({
      audited: [],
      afterRelease: [granted],
      next: [{ status: "requested", requestedBy: builder.userId }],
      rolledBack: ["requested"],
    });

    await reinstall();
  });

  it("take a declaration again the same with its actions reordered, and in its place when changed under the same binding", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Replaced ${unique()}`,
      access: "everyone",
    });
    const declared = notesOf(collectionId);
    await expect(
      install(releaseWith({ permissions: [declared] }))
    ).resolves.toBeTruthy();

    // Revoked in the database (as before admins were refused that): the
    // next install asks again, and keeps the revoked row as history.
    await env.DB.prepare(
      "UPDATE permissions SET status = 'revoked', revoked_by = 'test', revoked_at = 0 WHERE subject_id = ? AND status = 'requested'"
    )
      .bind(helloApp)
      .run();
    const restored = await auditedDuring(async () => {
      await expect(
        install(releaseWith({ permissions: [declared] }))
      ).resolves.toBeTruthy();
    });
    const { results: history } = await env.DB.prepare(
      "SELECT status, revoked_by AS revokedBy FROM permissions WHERE subject_id = ? AND revoked_by IS NOT 'grasp' ORDER BY requested_at, status"
    )
      .bind(helloApp)
      .all();
    expect({
      restored: permissionEvents(restored),
      history: history.slice(-2),
    }).toStrictEqual({
      restored: [["permission.requested", "system"]],
      history: [
        { status: "revoked", revokedBy: "test" },
        { status: "requested", revokedBy: null },
      ],
    });

    // The same permission with its actions in another order changes
    // nothing; one with other actions under the same binding takes its
    // place in one install, leaving one live request.
    const reordered = await auditedDuring(async () => {
      await expect(
        install(
          releaseWith({
            permissions: [{ ...declared, actions: ["write", "read"] }],
          })
        )
      ).resolves.toBeTruthy();
    });
    const replaced = await auditedDuring(async () => {
      await expect(
        install(
          releaseWith({ permissions: [{ ...declared, actions: ["read"] }] })
        )
      ).resolves.toBeTruthy();
    });
    expect({
      reordered: permissionEvents(reordered),
      replaced: permissionEvents(replaced),
      live: await helloRequests(true),
    }).toStrictEqual({
      reordered: [],
      replaced: [
        ["permission.revoked", "system"],
        ["permission.requested", "system"],
      ],
      live: [
        {
          binding: "NOTES",
          status: "requested",
          requestedBy: "grasp",
          revokedBy: null,
        },
      ],
    });

    await reinstall();
  });

  it("ask once when two installs race to declare the same permission", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const { collectionId } = await collectionWithNote(admin.api, {
      name: `Raced ${unique()}`,
      access: "everyone",
    });
    const declaring = releaseWith({
      permissions: [notesOf(collectionId)],
    }).blueprints.find(({ id }) => id === "hello");
    if (!declaring) {
      throw new Error("There's no declaring hello");
    }

    const events = await auditedDuring(async () => {
      const racing: Env = {
        ...env,
        DB: dbRacing(async () => {
          await installBuiltinBlueprint(env, declaring);
        }, insertsPermission),
      };
      // The other install asked first: this one is refused by the binding's
      // unique index, and writes nothing.
      await expect(installBuiltinBlueprint(racing, declaring)).rejects.toThrow(
        "UNIQUE"
      );
    });
    expect({
      live: await helloRequests(true),
      audited: permissionEvents(events),
    }).toStrictEqual({
      live: [
        {
          binding: "NOTES",
          status: "requested",
          requestedBy: "grasp",
          revokedBy: null,
        },
      ],
      audited: [["permission.requested", "system"]],
    });

    await reinstall();
  });

  it("aren't installed while app_blueprints is off", async () => {
    await reinstall();
    const before = await helloState();
    const off: Env = { ...env, FEATURES: { apps: true } };
    await expect(install(changedHello(), off)).resolves.toBeTruthy();
    await expect(helloState()).resolves.toStrictEqual(before);
  });
});
