import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { clientHistory, clientSettings } from "../src/clients/queries.ts";
import {
  SettingsError,
  setFeature,
  setRing,
  setSignIn,
} from "../src/clients/settings.ts";
import { act, consoleDatabase } from "../src/db/act.ts";
import { auditEvents, clients, settings } from "../src/db/schema.ts";
import { emptyStoreSecret, useStoreSecrets } from "./secrets-store.ts";

const db = consoleDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };
const other = { email: "other@grasp.test", sub: "sub-other" };

const signIn = {
  domains: ["acme.test"],
  admins: ["ada@acme.test"],
  googleHostedDomain: "acme.test",
};

/** An active client in ring 1, recorded as provisioning records one. */
const recordClient = async (): Promise<string> => {
  const id = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id,
        name: id,
        accountId: crypto.randomUUID().replaceAll("-", ""),
        ring: 1,
        status: "active",
        signIn: JSON.stringify(signIn),
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId: id }
  );
  return id;
};

/** Client `clientId`'s audit events of `action`, oldest first. */
const eventsOf = async (clientId: string, action: string) =>
  await db
    .select({
      actor: auditEvents.actor,
      target: auditEvents.target,
      detail: auditEvents.detail,
    })
    .from(auditEvents)
    .where(
      and(eq(auditEvents.clientId, clientId), eq(auditEvents.action, action))
    )
    .orderBy(asc(auditEvents.at), asc(sql`rowid`));

/** What `task` was refused with, or `done`. */
const codeOf = async (task: Promise<unknown>): Promise<string> => {
  try {
    await task;
    return "done";
  } catch (error) {
    return error instanceof SettingsError ? error.code : "other";
  }
};

/** Client `clientId`'s record, as the settings change it. */
const recordOf = async (clientId: string) => {
  const [row] = await db
    .select({
      ring: clients.ring,
      signIn: clients.signIn,
      configChangedAt: clients.configChangedAt,
    })
    .from(clients)
    .where(eq(clients.id, clientId));
  return row;
};

/** A keyed fingerprint, as the audit log records one: an HMAC-SHA256, hex. */
const fingerprintPattern = /^[0-9a-f]{64}$/u;

/** A sign-in change's audit detail: what it says of the admins it set. */
const signInDetailSchema = z.looseObject({
  admins: z.number(),
  adminsFingerprint: z.string(),
});

/** What each of client `clientId`'s sign-in changes recorded, oldest first. */
const signInDetailsOf = async (clientId: string) => {
  const events = await eventsOf(clientId, "client.sign_in");
  return events.map(({ detail }) =>
    signInDetailSchema.parse(JSON.parse(detail ?? "null"))
  );
};

describe("a client's settings", () => {
  useStoreSecrets({
    deployer: "test-deployer-token-settings-2b9d41",
    tenant: "test-tenant-admin-token-settings-7e0c63",
  });

  it("move a client to another ring, audited once per change, and leave its config as it was", async () => {
    const clientId = await recordClient();

    const changed = [
      await setRing(env, staff, { clientId, ring: 3 }),
      await setRing(env, staff, { clientId, ring: 3 }),
    ];

    expect({
      changed,
      record: await recordOf(clientId),
      events: await eventsOf(clientId, "client.ring"),
      settings: await clientSettings(db, clientId),
    }).toMatchObject({
      changed: [true, false],
      record: {
        ring: 3,
        signIn: JSON.stringify(signIn),
        configChangedAt: null,
      },
      events: [
        {
          actor: staff.email,
          target: null,
          detail: JSON.stringify({ ring: 3 }),
        },
      ],
      settings: { ring: 3 },
    });
  });

  it("switch feature flags one at a time, so two staff switching two at once both land, each audited once and marking the config changed", async () => {
    const clientId = await recordClient();

    const raced = await Promise.all([
      setFeature(env, staff, { clientId, feature: "apps", on: true }),
      setFeature(env, other, { clientId, feature: "knowledge", on: true }),
    ]);
    const afterRace = await recordOf(clientId);
    const again = await setFeature(env, staff, {
      clientId,
      feature: "apps",
      on: true,
    });
    const unchanged = await recordOf(clientId);
    const off = await setFeature(env, staff, {
      clientId,
      feature: "apps",
      on: false,
    });

    const events = await eventsOf(clientId, "client.feature");
    const shown = await clientSettings(db, clientId);
    expect({
      raced,
      again,
      off,
      features: shown?.features,
      marked: afterRace?.configChangedAt instanceof Date,
      // A switch that changes nothing doesn't count as a change.
      sameMark:
        unchanged?.configChangedAt?.getTime() ===
        afterRace?.configChangedAt?.getTime(),
      // The race's two in either order, then switching apps off.
      events: [
        ...events
          .slice(0, 2)
          .toSorted((a, b) => (a.target ?? "").localeCompare(b.target ?? "")),
        ...events.slice(2),
      ].map(({ target, detail }) => ({ target, detail })),
    }).toStrictEqual({
      raced: [true, true],
      again: false,
      off: true,
      features: { apps: false, knowledge: true },
      marked: true,
      sameMark: true,
      events: [
        { target: "apps", detail: JSON.stringify({ on: true }) },
        { target: "knowledge", detail: JSON.stringify({ on: true }) },
        { target: "apps", detail: JSON.stringify({ on: false }) },
      ],
    });
  });

  it("refuse a feature name core couldn't have, and a client that doesn't exist", async () => {
    const clientId = await recordClient();

    const refused = {
      name: await codeOf(
        setFeature(env, staff, { clientId, feature: "Apps!", on: true })
      ),
      client: await codeOf(
        setFeature(env, staff, {
          clientId: "no-such-client",
          feature: "apps",
          on: true,
        })
      ),
      ring: await codeOf(
        setRing(env, staff, { clientId: "no-such-client", ring: 2 })
      ),
    };

    const rows = await db
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.clientId, clientId));
    expect({ refused, rows }).toStrictEqual({
      // A name the schema refuses fails before anything is read.
      refused: {
        name: "other",
        client: "unknown_client",
        ring: "unknown_client",
      },
      rows: [],
    });
  });

  it("change a client's sign-in, audited with its domains, its IdP and a fingerprint of its admins but never their emails, and mark its config changed", async () => {
    const clientId = await recordClient();
    const changedTo = {
      domains: ["acme.test", "acme-group.test"],
      admins: ["bo@acme-group.test"],
      entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
    };

    const changed = [
      await setSignIn(env, staff, { clientId, signIn: changedTo }),
      await setSignIn(env, staff, { clientId, signIn: changedTo }),
    ];

    const record = await recordOf(clientId);
    const events = await eventsOf(clientId, "client.sign_in");
    const details = await signInDetailsOf(clientId);
    const shown = await clientSettings(db, clientId);
    expect({
      changed,
      signIn: z.unknown().parse(JSON.parse(record?.signIn ?? "null")),
      marked: record?.configChangedAt instanceof Date,
      shown: shown?.signIn,
      events: events.map(({ actor, target }) => ({ actor, target })),
      // Every field it records: its admins as a count and a fingerprint.
      details: details.map((detail) => ({
        ...detail,
        adminsFingerprint: fingerprintPattern.test(detail.adminsFingerprint),
      })),
      emailsAudited: events.some(
        ({ detail }) => detail?.includes("@") === true
      ),
    }).toStrictEqual({
      changed: [true, false],
      signIn: changedTo,
      marked: true,
      shown: changedTo,
      events: [{ actor: staff.email, target: null }],
      details: [
        {
          domains: "acme.test,acme-group.test",
          admins: 1,
          adminsFingerprint: true,
          entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
        },
      ],
      emailsAudited: false,
    });
  });

  it("tell which admins each sign-in change set: another fingerprint for another admin, the same for the same people in any order, and another at another client", async () => {
    const clientId = await recordClient();
    const elsewhere = await recordClient();
    const withAdmins = (...admins: string[]) => ({ ...signIn, admins });

    await setSignIn(env, staff, {
      clientId,
      signIn: withAdmins("ada@acme.test", "bo@acme.test"),
    });
    await setSignIn(env, staff, {
      clientId,
      signIn: withAdmins("ada@acme.test", "cy@acme.test"),
    });
    await setSignIn(env, staff, {
      clientId,
      signIn: withAdmins("bo@acme.test", "ada@acme.test"),
    });
    await setSignIn(env, staff, {
      clientId: elsewhere,
      signIn: withAdmins("ada@acme.test", "bo@acme.test"),
    });

    const [first, swapped, back] = await signInDetailsOf(clientId);
    const [atOther] = await signInDetailsOf(elsewhere);
    expect({
      // The count alone can't tell the three apart.
      counts: [first?.admins, swapped?.admins, back?.admins],
      swapped: swapped?.adminsFingerprint === first?.adminsFingerprint,
      back: back?.adminsFingerprint === first?.adminsFingerprint,
      elsewhere: atOther?.adminsFingerprint === first?.adminsFingerprint,
    }).toStrictEqual({
      counts: [2, 2, 2],
      swapped: false,
      back: true,
      elsewhere: false,
    });
  });

  it("refuse a change of sign-in while Secrets Store has no key to fingerprint its admins with, and still take the one it has as no change", async () => {
    const clientId = await recordClient();
    const current = { ...signIn, admins: ["cy@acme.test"] };
    await setSignIn(env, staff, { clientId, signIn: current });
    const before = await recordOf(clientId);
    await emptyStoreSecret(env.CLIENT_KEY, "CLIENT_KEY");

    const saved = {
      // The form saved as it is: nothing to record, so no key is needed.
      unchanged: await setSignIn(env, staff, { clientId, signIn: current }),
      changed: await codeOf(
        setSignIn(env, staff, {
          clientId,
          signIn: { ...signIn, admins: ["bo@acme.test"] },
        })
      ),
    };

    const events = await eventsOf(clientId, "client.sign_in");
    expect({
      saved,
      record: await recordOf(clientId),
      events: events.length,
    }).toStrictEqual({
      saved: { unchanged: false, changed: "store_secret_missing" },
      record: before,
      // The one change made while the store had its key.
      events: 1,
    });
  });

  it("refuse a sign-in no first admin could sign in with, one through an IdP the console has no app for, or one that isn't one, and keep the one it had", async () => {
    const clientId = await recordClient();

    const refused = {
      noAdmin: await codeOf(
        setSignIn(env, staff, {
          clientId,
          signIn: { ...signIn, admins: [] },
        })
      ),
      outside: await codeOf(
        setSignIn(env, staff, {
          clientId,
          signIn: { ...signIn, admins: ["ada@elsewhere.test"] },
        })
      ),
      noIdp: await codeOf(
        setSignIn(env, staff, {
          clientId,
          signIn: { domains: signIn.domains, admins: signIn.admins },
        })
      ),
      garbled: await codeOf(
        setSignIn(env, staff, { clientId, signIn: "acme.test" })
      ),
      // Through Entra, on a console with no Entra app: no deploy could set it.
      noApp: await codeOf(
        setSignIn({ ...env, ENTRA_CLIENT_ID: "" }, staff, {
          clientId,
          signIn: {
            domains: signIn.domains,
            admins: signIn.admins,
            entraTenantId: "8f3c9a52-1d4e-4b6f-9a2c-3e5d7f9b1c2a",
          },
        })
      ),
    };

    expect({
      refused,
      record: await recordOf(clientId),
      events: await eventsOf(clientId, "client.sign_in"),
    }).toStrictEqual({
      refused: {
        noAdmin: "admin_unreachable",
        outside: "admin_unreachable",
        noIdp: "sign_in_invalid",
        garbled: "sign_in_invalid",
        noApp: "sign_in_app_missing",
      },
      record: {
        ring: 1,
        signIn: JSON.stringify(signIn),
        configChangedAt: null,
      },
      events: [],
    });
  });

  it("list a client's console actions newest first, and no other client's", async () => {
    const clientId = await recordClient();
    const otherClient = await recordClient();
    await setRing(env, staff, { clientId, ring: 2 });
    await setFeature(env, staff, { clientId, feature: "apps", on: true });
    await setRing(env, staff, { clientId: otherClient, ring: 4 });

    const history = await clientHistory(db, clientId);

    expect(history.map(({ action }) => action)).toStrictEqual([
      "client.feature",
      "client.ring",
      "client.create",
    ]);
  });
});
