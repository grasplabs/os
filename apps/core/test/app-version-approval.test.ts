import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import type { AppCallerInput } from "../src/app.ts";
import { setCurrentVersion } from "../src/apps.ts";
import {
  grantReviewed,
  racingDb,
  release,
  reviewedOf,
  serverBuilt,
} from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// An App's next version and its permission to write a collection it
// writes records to for the person whose call it runs in (through its
// collection stub, knowledge/records.ts). These tests start from the way
// that can fail: a builder who can't grant the permission ships other code
// under it, and the next version they make current writes as the admin who
// uses it, under a grant that admin gave the code before.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const personApi = async (role: Role): Promise<Person> =>
  await signedInApi(idp, role);

/** Each stub call's outcome: `{ ok }` with its answer, or `{ error }` with its code. */
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

  async link(caller: Caller, binding: string, input: unknown): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).linkWorkflow(caller, input));
  }

  async canWrite(caller: Caller, binding: string): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).canWrite(caller));
  }

  async record(caller: Caller, binding: string, id: string, version?: number): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).getRecord(caller, id, version));
  }

  async read(caller: Caller, binding: string, id: string): Promise<unknown> {
    return await outcome(async () => await this.stub(binding).getDocument(caller, id));
  }

  bindings(): string[] {
    return Object.keys(this.env as object).toSorted();
  }
}
`;

/**
 * The collection the Apps write, open to everyone, which an admin creates
 * before each test.
 */
let collectionId = "";

/** A permission for `app` to use the collection under `binding`. */
const collectionFor = (
  app: AppId,
  actions: string[] = ["read", "write"],
  binding = "NOTES"
): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "collection", collectionId },
  actions,
  binding,
});

const as = (userId: string): AppCallerInput => ({
  userId,
  mode: "interactive",
});

/** A note, as the App saves it. */
const drawn = { type: "doc", title: "Pay supplier invoices" };

/** The App's `save` of `record` at `path`, from `ifVersion`. */
const saveArgs = (
  path: string,
  record: Record<string, unknown>,
  ifVersion = 0,
  binding = "NOTES"
) => [binding, { path, ifVersion, record, body: "Paid weekly." }];

/**
 * A stub call's outcome: `{ error }` with its code, or `{ ok }` with only
 * the fields of what it answered that `shape` names.
 */
const answered = (called: unknown, shape: z.ZodRawShape) =>
  z
    .union([
      z.strictObject({ error: z.string() }),
      z.strictObject({ ok: z.object(shape) }),
    ])
    .parse(called);

/** What a test reads of a save. */
const savedShape = { path: z.string(), currentVersion: z.number() };

/**
 * An App `builder` built and released, which `admin` granted the collection
 * to write, and to read only.
 */
const builtBy = async (builder: Person, admin: Person): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name: `Map ${unique()}` });
  const app = appIdSchema.parse(id);
  await serverBuilt(
    id,
    await release(builder, id, { "app/server.ts": serverCode })
  );
  for (const request of [
    collectionFor(app),
    collectionFor(app, ["read"], "NOTES_READ"),
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one at a time, in order
    const { id: permission } = await builder.api.permissions.request(request);
    // oxlint-disable-next-line no-await-in-loop -- as above
    await grantReviewed(admin.api, permission);
  }
  return app;
};

/** `by` releases other server code for `app`, built ahead. */
const changedBy = async (
  by: Pick<Person, "api">,
  app: AppId,
  change: string
): Promise<void> => {
  await serverBuilt(
    app,
    await release(by, app, { "app/server.ts": `${serverCode}\n// ${change}\n` })
  );
};

/** The detail of each `action` event in `events`, by its target's ID. */
const details = (
  events: Awaited<ReturnType<typeof auditedDuring>>,
  action: string
): Map<string | undefined, Record<string, unknown>> =>
  new Map(
    events
      .filter((event) => event.action === action)
      .map(({ target, detail }) => [target?.id, detail])
  );

/** The App's permissions, as an admin lists them. */
const permissionsOf = async (admin: Person, app: AppId) => {
  const listed = await admin.api.permissions.list({ type: "app", appId: app });
  return listed.map(({ id, binding, status, requestedBy, grantedBy }) => ({
    id,
    binding,
    status,
    requestedBy,
    grantedBy,
  }));
};

describe("An App's next version", { timeout: 60_000 }, () => {
  // After the identity provider's mock is in place (`mockIdp`).
  beforeEach(async () => {
    const admin = await personApi("admin");
    ({ id: collectionId } = await admin.api.knowledge.createCollection({
      name: `Notes ${unique()}`,
      access: "everyone",
    }));
  });

  it("is asked again for its permission to write a collection when a builder makes it current, and keeps reading", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const [write, read] = await permissionsOf(admin, app);
    const path = `notes/pay-${unique()}.md`;
    const before = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, drawn)
    );

    // The attack: the builder ships other code, which the admin's next
    // call runs, under the grant the admin gave the code before.
    const events = await auditedDuring(async () => {
      await changedBy(builder, app, "Rewrites every rule.");
    });
    const after = await callApp(
      env,
      app,
      as(admin.userId),
      "save",
      saveArgs(path, drawn, 1)
    );

    expect({
      before: answered(before, savedShape),
      after,
      bindings: await callApp(env, app, as(admin.userId), "bindings", []),
      permissions: await permissionsOf(admin, app),
      audited: events
        .filter(({ action }) => action.startsWith("permission."))
        .map(({ action, actor, target, detail }) => ({
          action,
          actor,
          target,
          detail,
        })),
    }).toStrictEqual({
      before: { ok: { path, currentVersion: 1 } },
      // The new version has no stub to write the collection with.
      after: { error: "failed" },
      bindings: ["NOTES_READ", "STATISTICS"],
      // Asked for again, it is the newest request, and still says who
      // granted it before: not a first request.
      permissions: [
        read,
        {
          id: write?.id,
          binding: "NOTES",
          status: "requested",
          requestedBy: builder.userId,
          grantedBy: admin.userId,
        },
      ],
      audited: [
        {
          action: "permission.requested",
          actor: { type: "person", userId: builder.userId },
          target: { type: "permission", id: write?.id },
          detail: {
            subjectType: "app",
            subjectId: app,
            objectType: "collection",
            collectionId,
            actions: "read write",
            binding: "NOTES",
            version: 2,
            previous: 1,
            grantedBy: admin.userId,
          },
        },
      ],
    });

    // Granted again, by an admin who saw the new code, it writes again.
    await grantReviewed(admin.api, write?.id ?? "");
    await expect(
      callApp(env, app, as(admin.userId), "save", saveArgs(path, drawn, 1))
    ).resolves.toMatchObject({ ok: { path, currentVersion: 2 } });
  });

  it("records each permission it asks for again by the IDs its grant was recorded with", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const subject = { type: "app", appId: app } as const;
    const requests: PermissionRequest[] = [
      {
        subject,
        object: {
          type: "connection",
          connectionId: "connection-outlook",
          resource: "inbox",
          mask: ["body", "subject"],
        },
        actions: ["mail.list", "mail.send"],
        binding: "OUTLOOK",
      },
      {
        subject,
        object: { type: "connection", connectionId: "connection-shared" },
        actions: ["mail.list"],
        binding: "SHARED",
      },
      {
        subject,
        object: { type: "workflow", appId: app, workflowId: "pay" },
        actions: ["start"],
        binding: "PAY",
      },
    ];
    const granted = await auditedDuring(async () => {
      for (const request of requests) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        const { id } = await builder.api.permissions.request(request);
        // oxlint-disable-next-line no-await-in-loop -- as above
        await grantReviewed(admin.api, id);
      }
    });
    const events = await auditedDuring(async () => {
      await changedBy(builder, app, "Uses everything.");
    });
    const requested = details(events, "permission.requested");

    expect({
      count: requested.size,
      asked: [...details(granted, "permission.granted")].map(
        ([id, detail]) => requested.get(id) ?? { missing: id, detail }
      ),
    }).toStrictEqual({
      // With the permission to write the collection.
      count: 4,
      asked: [...details(granted, "permission.granted").values()].map(
        ({ requestedBy: _requestedBy, ...detail }) => ({
          ...detail,
          version: 2,
          previous: 1,
          grantedBy: admin.userId,
        })
      ),
    });
  });

  it("is asked again for a permission an admin grants just before the batch that makes it current", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const late = await builder.api.permissions.request(
      collectionFor(app, ["read", "write"], "NOTES_LATE")
    );
    await builder.api.apps.files.write(app, {
      "app/server.ts": `${serverCode}\n// Asks for more.\n`,
    });
    const { version } = await builder.api.apps.files.commit(app, "More");
    // The admin grants the request after everything the change reads, and
    // before its batch lands.
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await grantReviewed(admin.api, late.id);
      }, /^update "apps"/iu),
    };

    const events = await auditedDuring(async () => {
      await setCurrentVersion(racing, await builder.api.whoami(), app, version);
    });
    const listed = await permissionsOf(admin, app);

    expect({
      // Asked for again at the same time: in no particular order.
      permissions: listed
        .map(({ binding, status }) => ({ binding, status }))
        .toSorted((a, b) => a.binding.localeCompare(b.binding)),
      audited: events
        .filter(({ action }) => action === "permission.requested")
        .map(({ actor, detail }) => ({
          actor,
          binding: detail.binding,
          version: detail.version,
          grantedBy: detail.grantedBy,
        }))
        .toSorted((a, b) => String(a.binding).localeCompare(String(b.binding))),
    }).toStrictEqual({
      permissions: [
        { binding: "NOTES", status: "requested" },
        { binding: "NOTES_LATE", status: "requested" },
        { binding: "NOTES_READ", status: "active" },
      ],
      audited: ["NOTES", "NOTES_LATE"].map((binding) => ({
        actor: { type: "person", userId: builder.userId },
        binding,
        version,
        grantedBy: admin.userId,
      })),
    });
  });

  it("is refused a grant for the version the admin reviewed once a builder made another current", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const more = await builder.api.permissions.request(
      collectionFor(app, ["read", "write"], "NOTES_MORE")
    );
    // The admin reviews version 1; meanwhile the builder swaps the code.
    const reviewed = await reviewedOf(admin.api, more.id);
    await changedBy(builder, app, "Swapped while the admin looked.");

    const refused = await outcome(
      admin.api.permissions.grant(more.id, reviewed)
    );
    const listed = await permissionsOf(admin, app);
    const approved = await env.DB.prepare(
      "SELECT approved FROM app_versions WHERE app_id = ? AND version = 2"
    )
      .bind(app)
      .first("approved");

    expect({
      reviewed,
      refused,
      more: listed.find(({ binding }) => binding === "NOTES_MORE")?.status,
      approved,
    }).toStrictEqual({
      reviewed: { version: 1 },
      refused: "app.conflict",
      more: "requested",
      approved: 0,
    });
  });

  it("is asked again for the first version of a copy of code no admin approved", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    // A version never made current, marked as a blueprint.
    const { id } = await builder.api.apps.create({ name: `Map ${unique()}` });
    const source = appIdSchema.parse(id);
    await builder.api.apps.files.write(source, { "app/server.ts": serverCode });
    const { version } = await builder.api.apps.files.commit(
      source,
      "Never run"
    );
    await builder.api.permissions.request(collectionFor(source));
    await builder.api.apps.blueprints.mark(source, version);
    const created = await builder.api.apps.blueprints.create(source, version, {
      name: `Copy ${unique()}`,
    });
    const copy = appIdSchema.parse(created.app.id);
    const [asked] = created.permissions;
    await grantReviewed(admin.api, asked?.id ?? "");

    await builder.api.apps.versions.setCurrent(copy, 1);
    const listed = await permissionsOf(admin, copy);

    expect(listed.map(({ status }) => status)).toStrictEqual(["requested"]);
  });

  it("is asked again for its first version whatever blueprint its creator names", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    // A label anyone creating an App may give: not a copy of anything.
    const { id } = await builder.api.apps.create({
      name: `Map ${unique()}`,
      blueprint: "builtin-workflow-map@1",
    });
    const app = appIdSchema.parse(id);
    const asked = await builder.api.permissions.request(collectionFor(app));
    await grantReviewed(admin.api, asked.id);
    await changedBy(builder, app, "Its own code.");

    const [write] = await permissionsOf(admin, app);
    expect(write?.status).toBe("requested");
  });

  it("asks for nothing again when another request made the same version current first", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const granted = await permissionsOf(admin, app);
    await builder.api.apps.files.write(app, {
      "app/server.ts": `${serverCode}\n// Reviewed.\n`,
    });
    const { version } = await builder.api.apps.files.commit(app, "Reviewed");
    // The admin makes it current after the builder's request read the
    // App, and before its batch lands: that batch changes nothing.
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await admin.api.apps.versions.setCurrent(app, version);
      }, /^update "apps"/iu),
    };

    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(
        setCurrentVersion(racing, await builder.api.whoami(), app, version)
      );
    });

    expect({
      refused,
      permissions: await permissionsOf(admin, app),
      audited: events.filter(({ action }) => action.startsWith("permission.")),
    }).toStrictEqual({
      refused: "app.conflict",
      permissions: granted,
      audited: [],
    });
  });

  it("is asked again when the admin making it current is no longer one as the change lands", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    await builder.api.apps.files.write(app, {
      "app/server.ts": `${serverCode}\n// Demoted.\n`,
    });
    const { version } = await builder.api.apps.files.commit(app, "Demoted");
    const racing: Env = {
      ...env,
      DB: racingDb(async () => {
        await env.DB.prepare(
          "UPDATE members SET role = 'builder' WHERE user_id = ?"
        )
          .bind(admin.userId)
          .run();
      }, /^update "apps"/iu),
    };

    // Checked as an admin when the request came in.
    await setCurrentVersion(racing, await admin.api.whoami(), app, version);
    const statuses = await env.DB.prepare(
      "SELECT binding, status FROM permissions WHERE subject_id = ? ORDER BY binding"
    )
      .bind(app)
      .all();
    const approved = await env.DB.prepare(
      "SELECT approved FROM app_versions WHERE app_id = ? AND version = ?"
    )
      .bind(app, version)
      .first("approved");

    expect({ statuses: statuses.results, approved }).toStrictEqual({
      statuses: [
        { binding: "NOTES", status: "requested" },
        { binding: "NOTES_READ", status: "active" },
      ],
      approved: 0,
    });
  });

  it("keeps its permissions when an admin makes it current, as they could grant them, and not when Grasp staff do", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const app = await builtBy(builder, admin);
    const granted = await permissionsOf(admin, app);

    const events = await auditedDuring(async () => {
      await changedBy(admin, app, "Reviewed by an admin.");
    });
    const path = `notes/pay-${unique()}.md`;

    expect({
      permissions: await permissionsOf(admin, app),
      audited: events.filter(({ action }) => action.startsWith("permission.")),
      saved: answered(
        await callApp(
          env,
          app,
          as(admin.userId),
          "save",
          saveArgs(path, drawn)
        ),
        savedShape
      ),
    }).toStrictEqual({
      permissions: granted,
      audited: [],
      saved: { ok: { path, currentVersion: 1 } },
    });

    // Grasp staff are admins, but never decide a client's permissions.
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    await changedBy({ api: core.authenticate() }, app, "Changed by staff.");
    const byStaff = await permissionsOf(admin, app);
    expect(
      byStaff.map(({ binding, status }) => ({ binding, status }))
    ).toStrictEqual([
      { binding: "NOTES_READ", status: "active" },
      { binding: "NOTES", status: "requested" },
    ]);
  });
});
