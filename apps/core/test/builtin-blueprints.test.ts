import { workflowIdOf } from "@grasp-os/compiler";
import { checkWorkflowBindings } from "@grasp-os/sdk/describe";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import type { DeclaredPermission } from "@grasp-os/shared/permissions";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { BuiltinBlueprint } from "#blueprints";

import { installBuiltinBlueprint } from "../src/app-blueprints.ts";
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
import { auditedDuring, outcome, signedInApi, unique } from "./sign-in.ts";

// The built-in blueprints: blueprints that ship with each release,
// installed on the first request (src/builtins.ts) as blueprints like any
// other (src/app-blueprints.ts). These tests start from the ways that can
// fail: a built-in isn't listed, or can't be created from, as any
// blueprint is; it leaves an App behind that anyone finds, changes, runs,
// shares or asks permissions for; anyone, an admin too, unmarks it; a
// changed release doesn't reach it, is recorded twice when two installs
// race, or changes an App already created from it; an unchanged release
// writes again; a failure halfway is recorded as done; someone who builds
// can't find or copy it, or a user can; a copy doesn't ask for what the
// release declares, or keeps asking once it no longer does; and a
// built-in the release ships doesn't build.
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

/** The singleton's install, asked for by an isolate of this release. */
const ensureInstalled = async (): Promise<boolean> =>
  await builtins(env).ensureInstalled(await fingerprintOf(release));

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

/** `hello` as stored. */
const helloRow = async () =>
  await env.DB.prepare(
    "SELECT name, description, tree, permissions FROM blueprints WHERE id = 'hello'"
  ).first<{
    name: string;
    description: string;
    tree: string;
    permissions: string;
  }>();

/** The actions of the audit events of `hello` in `events`. */
const helloActions = (
  events: { action: string; target?: { id: string } }[]
): string[] =>
  events
    .filter(({ target }) => target?.id === "hello")
    .map(({ action }) => action);

/** A permission to read and write the collection `collectionId`. */
const notesOf = (collectionId: CollectionId): DeclaredPermission => ({
  object: { type: "collection", collectionId },
  actions: ["read", "write"],
  binding: "NOTES",
});

const writesBlueprint = /^update "blueprints"/iu;

/** `racingDb`, racing the batch that changes a blueprint. */
const dbRacing = (first: () => Promise<unknown>): D1Database =>
  racingDb(first, writesBlueprint);

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

  it("are blueprints that everyone who builds finds and creates from, and users don't", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const builder = await signedInApi(idp, "builder");
    const user = await signedInApi(idp, "user");

    // Shared with nobody, and found by every builder all the same.
    const listed = await builder.api.apps.blueprints.list();
    expect(listed.find(({ id }) => id === "hello")).toMatchObject({
      id: "hello",
      name: hello().name,
      description: hello().description,
      app: null,
      version: null,
      markedBy: null,
      permissions: [],
    });

    const created = await builder.api.apps.blueprints.create("hello", {
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
      blueprint: "hello",
      owner: builder.userId,
      permissions: [],
      files: hello().files,
      greeting: "Hello, Ann: greeting 1",
    });

    // Users build no Apps: they neither find a built-in nor create from one.
    const theirs = await user.api.apps.blueprints.list();
    expect({
      found: theirs.some(({ id }) => id === "hello"),
      create: await outcome(
        user.api.apps.blueprints.create("hello", { name: "Mine" })
      ),
    }).toStrictEqual({ found: false, create: "role.forbidden" });
  });

  it("leave no App behind, and can't be unmarked, by an admin neither", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const admin = await signedInApi(idp, "admin");
    const before = await helloRow();
    const caller = await admin.api.apps.create({ name: `Caller ${unique()}` });
    const listed = await admin.api.apps.list();

    expect({
      // No App for anyone to change, run, share or ask permissions for.
      apps: listed.filter(({ owner }) => owner === "grasp"),
      unmark: await outcome(admin.api.apps.blueprints.unmark("hello")),
      calls: await outcome(
        admin.api.permissions.request({
          subject: { type: "app", appId: caller.id },
          object: { type: "app", appId: "hello" },
          actions: ["read"],
          binding: "HELLO",
        })
      ),
      after: await helloRow(),
    }).toStrictEqual({
      apps: [],
      // Only the release changes it.
      unmark: "role.forbidden",
      // There's no App of it to call.
      calls: "app.not_found",
      after: before,
    });
  });

  it("each create an App that builds", async () => {
    await expect(ensureInstalled()).resolves.toBeTruthy();
    const builder = await signedInApi(idp, "builder");
    for (const blueprint of release.blueprints) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time, as the install does
      const created = await builder.api.apps.blueprints.create(blueprint.id, {
        name: blueprint.name,
      });
      // Its workflows' tests run as it becomes current.
      // oxlint-disable-next-line no-await-in-loop -- as above
      await builder.api.apps.versions.setCurrent(created.app.id, 1);
      if ("app/server.ts" in blueprint.files) {
        // oxlint-disable-next-line no-await-in-loop -- as above
        await serverBuilt(created.app.id, 1);
      }
      // Its workflows call the App's bindings where a review can name each
      // call, as the check of an agent's draft over it asks: none throws.
      for (const [path, source] of Object.entries(blueprint.files)) {
        if (workflowIdOf(path) !== undefined) {
          checkWorkflowBindings(source);
        }
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

  it("take a changed release once, and leave Apps created from them alone", async () => {
    await reinstall();
    const admin = await signedInApi(idp, "admin");
    const before = await helloRow();
    const created = await admin.api.apps.blueprints.create("hello", {
      name: "Kept",
    });

    const events = await auditedDuring(async () => {
      await expect(install(changedHello())).resolves.toBeTruthy();
      // Installed again with nothing changed: nothing more is written.
      await expect(install(changedHello())).resolves.toBeTruthy();
    });
    const after = await admin.api.apps.blueprints.create("hello", {
      name: "Changed",
    });
    const stored = await helloRow();
    expect({
      changed: stored?.tree !== before?.tree,
      audited: helloActions(events),
      kept: await admin.api.apps.files.read(created.app.id, 1),
      after: await admin.api.apps.files.read(after.app.id, 1),
    }).toStrictEqual({
      changed: true,
      audited: ["blueprint.changed"],
      kept: hello().files,
      after: changedHello().blueprints.find(({ id }) => id === "hello")?.files,
    });

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
        .filter(({ id }) => id === "hello")
        .map(({ name, description }) => [name, description]),
      audited: helloActions(events),
    }).toStrictEqual({
      listed: [["Hi", "Says hi."]],
      audited: ["blueprint.changed"],
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
      collection,
      created: events.filter(
        ({ action, target }) =>
          action === "knowledge.collection.created" && target?.id === id
      ).length,
      admin: await save(admin),
      builder: await save(builder),
    }).toStrictEqual({
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

  it("are recorded once when two installs race to change them", async () => {
    await reinstall();
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
      // The other install changed it first: this one changes nothing, and
      // records nothing.
      await expect(
        outcome(installBuiltinBlueprint(racing, changed))
      ).resolves.toBe("ok");
    });
    const raced = await helloRow();
    await expect(install(changedHello())).resolves.toBeTruthy();
    expect({
      stored: raced,
      audited: helloActions(events),
    }).toStrictEqual({
      stored: await helloRow(),
      audited: ["blueprint.changed"],
    });

    await reinstall();
  });

  it("aren't recorded as installed after a failure halfway, and the next install finishes", async () => {
    await reinstall();
    const before = await helloRow();
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
    expect([stamped, await helloRow()]).toStrictEqual([undefined, before]);

    await expect(install(changedHello())).resolves.toBeTruthy();
    const finished = await helloRow();
    expect(finished?.tree).not.toBe(before?.tree);

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
    await expect(fingerprintOf(declaring)).resolves.not.toBe(
      await fingerprintOf(release)
    );
    const redeclared = await auditedDuring(async () => {
      await expect(install(declaring)).resolves.toBeTruthy();
      // Installed again: nothing more is written.
      await expect(install(declaring)).resolves.toBeTruthy();
    });
    const listed = await builder.api.apps.blueprints.list();
    expect({
      declared: listed.find(({ id }) => id === "hello")?.permissions,
      audited: helloActions(redeclared),
    }).toStrictEqual({
      declared: [declared],
      audited: ["blueprint.changed"],
    });

    // A copy asks for it, for an admin to grant, and gets it.
    const created = await builder.api.apps.blueprints.create("hello", {
      name: "Asks",
    });
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

    // The release stops declaring it: the copy keeps what it was granted,
    // and a new copy asks for nothing.
    await expect(install(release)).resolves.toBeTruthy();
    const later = await builder.api.apps.blueprints.create("hello", {
      name: "Asks nothing",
    });
    expect({
      copy: await admin.api.permissions.list({
        type: "app",
        appId: created.app.id,
      }),
      later: later.permissions,
    }).toStrictEqual({
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
    const created = await builder.api.apps.blueprints.create("hello", {
      name: "Granted",
    });
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
    const { version } = await builder.api.apps.files.commit(
      created.app.id,
      {
        "app/server.ts": `${hello().files["app/server.ts"]}\n// Mine.\n`,
      },
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
});
