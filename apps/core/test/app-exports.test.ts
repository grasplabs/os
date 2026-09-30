import type { PermissionRequest } from "@grasp-os/shared/permissions";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { grantReviewed, release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedInApi,
  unique,
} from "./sign-in.ts";

// Asking for another App's exports: the permission an App needs to call
// the methods another App lets other Apps call. These tests start from
// the ways asking can go wrong: someone asks to call an App they can't
// see (and learns it exists), an App asks for its own methods, an agent
// asks at all, an action that isn't one, the request goes through while
// the feature is off, or a grant to write outlives code no admin saw.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** A request for `consumer` to call `provider`'s exports. */
const exportsOf = (
  consumer: string,
  provider: string,
  actions: string[] = ["read"],
  binding = "CRM"
): PermissionRequest => ({
  subject: { type: "app", appId: consumer },
  object: { type: "app", appId: provider },
  actions,
  binding,
});

/** A new App of `owner`'s. */
const newApp = async (owner: Person, name = "App"): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `${name} ${unique()}` });
  return id;
};

/** Rows ordered by their first cell, a binding name. */
const byBinding = (one: string[], other: string[]): number =>
  String(one[0]).localeCompare(String(other[0]));

describe("another App's exports", () => {
  it("are asked for by a builder of the calling App who has a role in the called one", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const invoicing = await newApp(builder, "Invoicing");
    const crm = await newApp(admin, "CRM");

    // The CRM isn't shared with them: they learn nothing of it.
    const hidden = await outcome(
      builder.api.permissions.request(exportsOf(invoicing, crm))
    );
    await admin.api.apps.members.add(crm, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    const requested = await builder.api.permissions.request(
      exportsOf(invoicing, crm, ["findCustomers", "write"])
    );
    expect({ hidden, requested }).toMatchObject({
      hidden: "app.not_found",
      requested: {
        subject: { type: "app", appId: invoicing },
        object: { type: "app", appId: crm },
        actions: ["findCustomers", "write"],
        status: "requested",
      },
    });
    // Listed to those who see both Apps, as a workflow of another App is.
    const listed = async (person: Person) => {
      const all = await person.api.permissions.list();
      return all.some(({ id }) => id === requested.id);
    };
    const other = await personApi("builder");
    await expect(
      Promise.all([listed(admin), listed(builder), listed(other)])
    ).resolves.toStrictEqual([true, true, false]);
  });

  it("are never asked for the App itself, for an agent, or with an action that isn't one", async () => {
    const admin = await personApi("admin");
    const [app, other] = await Promise.all([
      newApp(admin),
      newApp(admin, "Other"),
    ]);
    const refused = await Promise.all(
      [
        exportsOf(app, app),
        {
          ...exportsOf(app, other),
          subject: { type: "agent" as const, agentId: `agent-${unique()}` },
        },
        exportsOf(app, other, ["FindCustomers"]),
        exportsOf(app, other, ["find_customers"]),
        exportsOf(app, other, ["toString"]),
        exportsOf(app, `app-${unique()}`),
      ].map(
        async (request) => await outcome(admin.api.permissions.request(request))
      )
    );
    expect(refused).toStrictEqual([
      "permission.invalid",
      "permission.invalid",
      "permission.invalid",
      "permission.invalid",
      "permission.invalid",
      // As for any App the person has no role in.
      "app.not_found",
    ]);
  });

  it("are refused while App calls are switched off", async () => {
    const admin = await personApi("admin");
    const [app, other] = await Promise.all([
      newApp(admin),
      newApp(admin, "Other"),
    ]);
    const off: Env = {
      ...env,
      FEATURES: { apps: true, permissions: true },
    };
    const { core } = await openRpc(admin.session, { coreEnv: off });
    await expect(
      outcome(core.authenticate().permissions.request(exportsOf(app, other)))
    ).resolves.toBe("feature.disabled");
  });

  it("are asked for again when a builder makes a new version current, but for reading", async () => {
    const [admin, builder] = await Promise.all([
      personApi("admin"),
      personApi("builder"),
    ]);
    const invoicing = await newApp(builder, "Invoicing");
    const crm = await newApp(admin, "CRM");
    await admin.api.apps.members.add(crm, {
      type: "person",
      id: builder.userId,
      role: "user",
    });
    await release(builder, invoicing, {
      "app/server.ts": "export class App {}\n",
    });
    const asked = await Promise.all(
      [
        exportsOf(invoicing, crm, ["read"], "CRM_READ"),
        exportsOf(invoicing, crm, ["write"], "CRM_WRITE"),
        exportsOf(invoicing, crm, ["findCustomers"], "CRM_FIND"),
      ].map(async (request) => await builder.api.permissions.request(request))
    );
    for (const { id } of asked) {
      // oxlint-disable-next-line no-await-in-loop -- each reviewed on its own
      await grantReviewed(admin.api, id);
    }

    const events = await auditedDuring(async () => {
      await release(builder, invoicing, {
        "app/server.ts": "export class App {}\n// Changed.\n",
      });
    });
    const statuses = await admin.api.permissions.list({
      type: "app",
      appId: invoicing,
    });
    expect({
      statuses: statuses
        .map(({ binding, status }) => [binding, status])
        .toSorted(byBinding),
      audited: events
        .filter(({ action }) => action === "permission.requested")
        .map(({ detail }) => [
          String(detail.binding),
          String(detail.objectType),
          String(detail.appId),
        ])
        .toSorted(byBinding),
    }).toStrictEqual({
      // Reading is kept; one named by name may be marked `write` by the
      // next version of the CRM, so it is asked for again too.
      statuses: [
        ["CRM_FIND", "requested"],
        ["CRM_READ", "active"],
        ["CRM_WRITE", "requested"],
      ],
      audited: [
        ["CRM_FIND", "app", crm],
        ["CRM_WRITE", "app", crm],
      ],
    });
  });
});
