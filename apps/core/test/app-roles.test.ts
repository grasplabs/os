import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { outlook, release, serverBuilt } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
  unique,
} from "./sign-in.ts";

// App roles: an App is private to its owner and the organization's
// admins until a builder of it shares it with people or teams, as users
// (its screens) or builders (its code and settings). The ways this could
// go wrong, tried below: someone without a role reaching an App or
// learning it exists, a user changing code or settings or sharing it on,
// someone becoming a builder whose role in the organization doesn't
// build, access outliving unsharing or a team change, staff deciding whom
// a client's App reaches, and a change nobody recorded.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

const files = {
  "app/server.ts": "export class App {}\n",
  "screens/desk.tsx": "export default () => <p>Desk</p>;\n",
};

/** The run each App `newApp` makes has: one that has ended. */
const runOf = (app: string): string => `run-${app}`;

/** A released App of `owner`'s, its server built, with an ended run. */
const newApp = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  const version = await release(owner, id, files);
  await serverBuilt(id, version);
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, ended_at) VALUES (?, ?, 'report', ?, ?, 'completed', ?, ?)"
  )
    .bind(runOf(id), id, version, owner.userId, Date.now(), Date.now())
    .run();
  return id;
};

/** What `person` gets from each call their role in an App decides. */
const callsOn = async ({ api }: Person, app: string) => ({
  // What its screens use.
  get: await outcome(api.apps.get(app)),
  contents: await outcome(api.apps.contents(app)),
  screen: await outcome(api.screens.version(app)),
  report: await outcome(
    api.screens.report(
      app,
      { version: 1, screen: "desk" },
      { kind: "error", message: "Oops" }
    )
  ),
  open: await outcome(api.screens.open(app, "desk")),
  call: await outcome(api.screens.call(app, "missing", [])),
  runs: await outcome(api.workflows.list(app)),
  status: await outcome(api.workflows.status(runOf(app))),
  start: await outcome(api.workflows.start(app, "report")),
  allRuns: await outcome(api.workflows.runs({ app })),
  workflow: await outcome(api.workflows.get(app, "report")),
  members: await outcome(api.apps.members.list(app)),
  // Its code and settings.
  read: await outcome(api.apps.files.read(app)),
  commit: await outcome(
    api.apps.files.commit(app, { "notes.md": "# Mine\n" }, "Mine")
  ),
  versions: await outcome(api.apps.versions.list(app)),
  version: await outcome(api.apps.versions.get(app, 1)),
  diff: await outcome(api.apps.versions.diff(app, 1, 1)),
  propose: await outcome(api.apps.versions.propose(app, 1)),
  setCurrent: await outcome(api.apps.versions.setCurrent(app, 1)),
  errors: await outcome(api.screens.errors(app)),
  params: await outcome(api.workflows.params.list(app, "report")),
  test: await outcome(api.workflows.test(app, "report")),
  cancel: await outcome(api.workflows.cancel(runOf(app))),
  permission: await outcome(
    api.permissions.request({
      ...outlook(app),
      binding: `B_${unique().toUpperCase()}`,
    })
  ),
  share: await outcome(
    api.apps.members.add(app, { type: "team", id: "team-none", role: "user" })
  ),
});

const asUser = {
  get: "ok",
  contents: "ok",
  screen: "ok",
  report: "ok",
  open: "ok",
  // Past the role check: the App's server fails on a method it lacks.
  call: "app.failed",
  runs: "ok",
  status: "ok",
  // Past the role check: the App has no such workflow.
  start: "workflow.not_found",
  allRuns: "ok",
  // Past the role check: the App has no such workflow.
  workflow: "workflow.not_found",
  members: "ok",
  read: "role.forbidden",
  commit: "role.forbidden",
  versions: "role.forbidden",
  version: "role.forbidden",
  diff: "role.forbidden",
  propose: "role.forbidden",
  setCurrent: "role.forbidden",
  errors: "role.forbidden",
  params: "role.forbidden",
  test: "role.forbidden",
  cancel: "role.forbidden",
  permission: "role.forbidden",
  share: "role.forbidden",
};

/** Whether `person` finds `app` among theirs. */
const lists = async ({ api }: Person, app: string): Promise<boolean> => {
  const apps = await api.apps.list();
  return apps.some(({ id }) => id === app);
};

// Each test releases an App of its own and, through `callsOn`, makes some
// thirty calls in a row, opening its screen among them: that builds the
// screens of that App's version, which the build cache can't share across
// Apps (it keys builds by App). The server is built ahead (`serverBuilt`),
// but a loaded runner still takes longer than the default five seconds,
// as screen-bridge.test.ts's tests do.
describe("App roles", { timeout: 60_000 }, () => {
  it("keep an App private to its owner and the admins", async () => {
    const owner = await personApi("builder");
    const [builder, user, admin] = await Promise.all([
      personApi("builder"),
      personApi("user"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);

    const outsider = await callsOn(builder, app);
    // Refused as an App that isn't there, so nobody learns it exists.
    expect(new Set(Object.values(outsider))).toStrictEqual(
      new Set(["app.not_found"])
    );
    await expect(callsOn(user, app)).resolves.toStrictEqual(
      Object.fromEntries(
        Object.keys(outsider).map((call) => [
          call,
          // The organization's users never build, whatever the App.
          call === "permission" ? "role.forbidden" : "app.not_found",
        ])
      )
    );
    await expect(
      Promise.all(
        [builder, user, admin, owner].map(async (p) => await lists(p, app))
      )
    ).resolves.toStrictEqual([false, false, true, true]);
    // Admins manage every App.
    await expect(
      outcome(
        admin.api.apps.files.commit(app, { "notes.md": "# Admin\n" }, "Admin")
      )
    ).resolves.toBe("ok");
  });

  it("let a user work in an App's screens and nothing more, and a builder build it", async () => {
    const owner = await personApi("builder");
    const [user, builder] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const app = await newApp(owner);
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: builder.userId,
      role: "builder",
    });

    await expect(callsOn(user, app)).resolves.toStrictEqual(asUser);
    const asBuilder = await callsOn(builder, app);
    expect(asBuilder).toMatchObject({
      read: "ok",
      commit: "ok",
      versions: "ok",
      version: "ok",
      diff: "ok",
      propose: "ok",
      setCurrent: "ok",
      errors: "ok",
      cancel: "ok",
      // Refused for the workflow it doesn't have, past the role check.
      params: "workflow.not_found",
      test: "workflow.not_found",
      permission: "ok",
      // Refused for the team there isn't, past the role check.
      share: "app.member_invalid",
    });
    await expect(
      Promise.all([lists(user, app), lists(builder, app)])
    ).resolves.toStrictEqual([true, true]);
    const members = await user.api.apps.members.list(app);
    expect(
      members
        .map(({ id, name, role, addedBy }) => ({ id, name, role, addedBy }))
        .toSorted((a, b) => a.role.localeCompare(b.role))
    ).toStrictEqual([
      {
        id: builder.userId,
        name: builder.person.name,
        role: "builder",
        addedBy: owner.userId,
      },
      {
        id: user.userId,
        name: user.person.name,
        role: "user",
        addedBy: owner.userId,
      },
    ]);
  });

  it("follow a team's people as they join and leave it", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [anna, ben] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const team = await newTeam(admin, [anna]);
    const app = await newApp(owner);
    await owner.api.apps.members.add(app, {
      type: "team",
      id: team,
      role: "builder",
    });
    // As a person too, in a lower role: the higher one counts.
    await owner.api.apps.members.add(app, {
      type: "person",
      id: anna.userId,
      role: "user",
    });

    await expect(
      Promise.all([
        outcome(anna.api.apps.files.read(app)),
        outcome(ben.api.apps.get(app)),
      ])
    ).resolves.toStrictEqual(["ok", "app.not_found"]);

    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM team_members WHERE team_id = ? AND user_id = ?"
      ).bind(team, anna.userId),
      env.DB.prepare(
        "INSERT INTO team_members (id, team_id, user_id, created_at) VALUES (?, ?, ?, ?)"
      ).bind(crypto.randomUUID(), team, ben.userId, Date.now()),
    ]);
    await expect(
      Promise.all([
        outcome(anna.api.apps.files.read(app)),
        outcome(anna.api.apps.get(app)),
        outcome(ben.api.apps.files.read(app)),
      ])
    ).resolves.toStrictEqual(["role.forbidden", "ok", "ok"]);
  });

  it("keep an App's permissions, and its workflows, to those with a role in it", async () => {
    const [owner, other, admin] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const app = await newApp(owner);
    const { id: permission } = await owner.api.permissions.request(
      outlook(app)
    );
    // An agent's permission names the App too, as a workflow's.
    const { id: agents } = await admin.api.permissions.request({
      subject: { type: "agent", agentId: `agent-${unique()}` },
      object: { type: "workflow", appId: app, workflowId: "report" },
      actions: ["start"],
      binding: "REPORT",
    });
    const { id: theirs } = await other.api.apps.create({ name: "Theirs" });
    const startsReport: PermissionRequest = {
      subject: { type: "app", appId: theirs },
      object: { type: "workflow", appId: app, workflowId: "report" },
      actions: ["start"],
      binding: "REPORT",
    };
    const listed = async (person: Person, subject?: string) => {
      const found = await person.api.permissions.list(
        subject === undefined ? undefined : { type: "app", appId: subject }
      );
      return [permission, agents].map((wanted) =>
        found.some(({ id }) => id === wanted)
      );
    };

    const before = {
      all: await listed(other),
      ofApp: await listed(other, app),
      admin: await listed(admin),
      // As for an App that isn't there.
      workflow: await outcome(other.api.permissions.request(startsReport)),
    };
    await owner.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    expect({
      before,
      after: {
        all: await listed(other),
        workflow: await outcome(other.api.permissions.request(startsReport)),
      },
    }).toStrictEqual({
      before: {
        all: [false, false],
        ofApp: [false, false],
        admin: [true, true],
        workflow: "app.not_found",
      },
      after: { all: [true, true], workflow: "ok" },
    });
  });

  it("list only people still in the organization, and teams that still exist", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [stays, leaves] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const [kept, deleted] = await Promise.all([
      newTeam(admin, []),
      newTeam(admin, []),
    ]);
    const app = await newApp(owner);
    for (const member of [
      { type: "person", id: stays.userId },
      { type: "person", id: leaves.userId },
      { type: "team", id: kept },
      { type: "team", id: deleted },
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one share at a time
      await owner.api.apps.members.add(app, { ...member, role: "user" });
    }

    await admin.api.members.remove(leaves.userId);
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(deleted).run();
    const listed = await owner.api.apps.members.list(app);
    expect(new Set(listed.map(({ id }) => id))).toStrictEqual(
      new Set([stays.userId, kept])
    );
  });

  it("never let someone build whose role in the organization doesn't", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const user = await personApi("user");
    const team = await newTeam(admin, [user]);
    const app = await newApp(owner);

    await expect(
      outcome(
        owner.api.apps.members.add(app, {
          type: "person",
          id: user.userId,
          role: "builder",
        })
      )
    ).resolves.toBe("app.member_invalid");
    // A team can be builders; each of its people builds only if they may.
    await owner.api.apps.members.add(app, {
      type: "team",
      id: team,
      role: "builder",
    });
    await expect(callsOn(user, app)).resolves.toStrictEqual(asUser);

    // Nor does the owner, once their role in the organization is `user`.
    await env.DB.prepare("UPDATE members SET role = 'user' WHERE user_id = ?")
      .bind(owner.userId)
      .run();
    await expect(
      Promise.all([
        outcome(owner.api.apps.get(app)),
        outcome(owner.api.apps.files.read(app)),
      ])
    ).resolves.toStrictEqual(["ok", "role.forbidden"]);
  });

  it("share only with the organization's people and teams, never the owner", async () => {
    const owner = await personApi("builder");
    const app = await newApp(owner);
    const shareWith = async (type: "person" | "team", id: string) =>
      await outcome(
        owner.api.apps.members.add(app, { type, id, role: "user" })
      );

    await expect(
      Promise.all([
        shareWith("person", "user-nobody"),
        shareWith("team", "team-nobody"),
        shareWith("person", owner.userId),
        outcome(
          owner.api.apps.members.add(app, {
            type: "person",
            id: owner.userId,
            // @ts-expect-error: not an App role, as a client could send it
            role: "admin",
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "app.member_invalid",
      "app.member_invalid",
      "app.member_invalid",
      "app.invalid",
    ]);
    await expect(owner.api.apps.members.list(app)).resolves.toStrictEqual([]);
  });

  it("stop at the next call once an App is unshared, and record who shared and unshared it", async () => {
    const owner = await personApi("builder");
    const person = await personApi("builder");
    const app = await newApp(owner);
    const member = { type: "person", id: person.userId } as const;

    const events = await auditedDuring(async () => {
      await owner.api.apps.members.add(app, { ...member, role: "user" });
      // Sharing again in the same role changes and records nothing.
      await owner.api.apps.members.add(app, { ...member, role: "user" });
      await owner.api.apps.members.add(app, { ...member, role: "builder" });
      await expect(person.api.apps.files.read(app)).resolves.toBeDefined();
      await owner.api.apps.members.remove(app, member);
      // So does unsharing again.
      await owner.api.apps.members.remove(app, member);
    });

    await expect(outcome(person.api.apps.get(app))).resolves.toBe(
      "app.not_found"
    );
    const target = { type: "app", id: app };
    const actor = { type: "person", userId: owner.userId };
    expect(
      events.map(({ actor: by, action, target: on, detail }) => ({
        by,
        action,
        on,
        detail,
      }))
    ).toStrictEqual(
      (
        [
          ["app.member.added", "user"],
          ["app.member.added", "builder"],
          ["app.member.removed", "builder"],
        ] as const
      ).map(([action, role]) => ({
        by: actor,
        action,
        on: target,
        detail: { memberType: "person", member: person.userId, role },
      }))
    );
  });

  it("leave whom a client's App reaches to the client, not Grasp staff", async () => {
    const owner = await personApi("builder");
    const person = await signedInWithRole(idp, "user");
    const app = await newApp(owner);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();

    await expect(
      Promise.all([
        outcome(staff.apps.files.read(app)),
        outcome(staff.apps.members.list(app)),
        outcome(
          staff.apps.members.add(app, {
            type: "person",
            id: person.userId,
            role: "user",
          })
        ),
      ])
    ).resolves.toStrictEqual(["ok", "ok", "role.forbidden"]);
  });

  it("are as before while sharing is switched off: builders on every App, users on none", async () => {
    const owner = await personApi("builder");
    const app = await newApp(owner);
    const coreEnv: Env = {
      ...env,
      FEATURES: { apps: true, screens: true },
    };
    const connect = async (role: Role) => {
      const { session } = await signedInWithRole(idp, role);
      const { core } = await openRpc(session, { coreEnv });
      return await core.authenticate();
    };
    const [builder, user] = await Promise.all([
      connect("builder"),
      connect("user"),
    ]);

    await expect(
      Promise.all([
        outcome(builder.apps.files.read(app)),
        builder.apps.list().then((all) => all.some(({ id }) => id === app)),
        outcome(builder.apps.members.list(app)),
        outcome(user.apps.get(app)),
        outcome(user.apps.list()),
      ])
    ).resolves.toStrictEqual([
      "ok",
      true,
      "feature.disabled",
      "role.forbidden",
      "role.forbidden",
    ]);
  });
});
