import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

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
import { serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { auditedDuring, openRpc, outcome, signedInApi } from "./sign-in.ts";

// The built-in blueprints: Apps' blueprints that ship with each release,
// installed on the first request (src/builtins.ts) through the App
// registry (src/app-blueprints.ts). These tests start from the ways that
// can fail: a built-in isn't listed, or can't be created from, as any
// blueprint is; a changed release doesn't reach it, writes it twice when
// two installs race, or changes an App already created from it; an
// unchanged release writes again; a failure halfway is recorded as done;
// someone who builds can't find or copy it, a user can, or anyone, an
// admin too, changes, runs, shares or asks permissions for it; and a
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

const insertsVersion = /^insert into "app_versions"/iu;

/**
 * Core's database, with `first` run once, just before the first batch
 * that writes an App version lands: another writer getting there first.
 */
const dbRacing = (first: () => Promise<unknown>): D1Database => {
  const real = env.DB;
  let writing = false;
  let raced = false;
  return {
    prepare: (query) => {
      writing ||= insertsVersion.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (writing && !raced) {
        raced = true;
        await first();
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};

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

  it("aren't installed while app_blueprints is off", async () => {
    await reinstall();
    const before = await helloState();
    const off: Env = { ...env, FEATURES: { apps: true } };
    await expect(install(changedHello(), off)).resolves.toBeTruthy();
    await expect(helloState()).resolves.toStrictEqual(before);
  });
});
