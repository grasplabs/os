/**
 * A client's settings, as staff change them on its page: its ring, its
 * feature flags (core's `FEATURES`, a row in `settings`) and its sign-in
 * (its record's `signIn`, which every deploy makes core's `SIGN_IN`
 * from). Each change is audited in the same batch as the change, and
 * only when it changes something.
 *
 * None of it reaches the client's account at once. The ring decides which
 * rollouts reach it; flags and sign-in are set on core by its next deploy.
 * They also mark the client (`configChangedAt`), so the next rollout
 * deploys it even when it's on the release already (src/rollout/targets.ts).
 */
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clients, settings } from "../db/schema.ts";
import { adminUnreachable, clientSignInSchema } from "../deploy/core-config.ts";
import { featureNameSchema } from "./feature-name.ts";

/** Why staff's change to a client's settings was refused, as the page words it. */
export const settingsErrorCodes = [
  /** No such client. */
  "unknown_client",
  /** The sign-in isn't one: no IdP, a domain or email that isn't one. */
  "sign_in_invalid",
  /** The sign-in names no first admin, or one whose email isn't in its domains. */
  adminUnreachable,
] as const;
export type SettingsErrorCode = (typeof settingsErrorCodes)[number];

export class SettingsError extends Error {
  readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode, message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

/** The setting core's feature flags are in. */
const featuresKey = "FEATURES";

const clientIdSchema = z.string().min(1);

export const ringInputSchema = z.object({
  clientId: clientIdSchema,
  ring: z.int().nonnegative(),
});

export const featureInputSchema = z.object({
  clientId: clientIdSchema,
  feature: featureNameSchema,
  on: z.boolean(),
});

/**
 * A sign-in as the page sends it, checked here rather than by the server
 * function's validator, so a refusal comes back as its code.
 */
export const signInInputSchema = z.object({
  clientId: clientIdSchema,
  signIn: z.unknown(),
});

/** Throws `unknown_client` unless the console has client `clientId`. */
const assertClient = async (
  db: ConsoleDatabase,
  clientId: string
): Promise<void> => {
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(eq(clients.id, clientId));
  if (client === undefined) {
    throw new SettingsError("unknown_client", `No client ${clientId}`);
  }
};

/**
 * Moves client `clientId` to ring `ring`, as `staff`, audited
 * (`client.ring`) when it changes: rollouts started from then on reach it
 * with that ring. Returns whether it changed.
 */
export const setRing = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof ringInputSchema>
): Promise<boolean> => {
  const db = consoleDatabase(env.DB);
  const { clientId, ring } = ringInputSchema.parse(input);
  await assertClient(db, clientId);
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ ring, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), ne(clients.ring, ring))),
    { action: "client.ring", clientId, detail: { ring } }
  );
};

/**
 * Marks client `clientId`'s config changed at `now`, as the statement
 * that follows `actIfChanged`'s audit event: `changes()` then counts that
 * event's insert, which happened only if the change did.
 */
const configChanged = (db: ConsoleDatabase, clientId: string, now: Date) =>
  db
    .update(clients)
    .set({ configChangedAt: now, updatedAt: now })
    .where(and(eq(clients.id, clientId), sql`changes() > 0`));

/**
 * Switches feature `feature` on or off in client `clientId`'s `FEATURES`,
 * as `staff`, audited (`client.feature`) when it changes. One flag at a
 * time, set inside the stored JSON, so staff changing two flags at once
 * both land. Returns whether it changed.
 */
export const setFeature = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof featureInputSchema>
): Promise<boolean> => {
  const db = consoleDatabase(env.DB);
  const { clientId, feature, on } = featureInputSchema.parse(input);
  await assertClient(db, clientId);
  const now = new Date();
  // The name is checked above, so it's safe in a JSON path.
  const path = `$.${feature}`;
  const flag = on ? sql`json('true')` : sql`json('false')`;
  return await actIfChanged(
    db,
    staff,
    db
      .insert(settings)
      .values({
        clientId,
        key: featuresKey,
        value: JSON.stringify({ [feature]: on }),
        updatedBy: staff.email,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [settings.clientId, settings.key],
        set: {
          value: sql`json_set(${settings.value}, ${path}, ${flag})`,
          updatedBy: staff.email,
          updatedAt: now,
        },
        setWhere: sql`json_extract(${settings.value}, ${path}) IS NOT ${on ? 1 : 0}`,
      }),
    { action: "client.feature", clientId, target: feature, detail: { on } },
    [configChanged(db, clientId, now)]
  );
};

/**
 * Sets client `clientId`'s sign-in, as `staff`, audited (`client.sign_in`,
 * with its domains and IdPs, and only a count of its admins, whose emails
 * are personal data) when it changes. Its
 * next deploy makes core's `SIGN_IN` from it. Refused as the record's own
 * rule refuses it: `admin_unreachable` without a first admin who can sign
 * in, `sign_in_invalid` for anything else. Returns whether it changed.
 */
export const setSignIn = async (
  env: Env,
  staff: Staff,
  input: z.input<typeof signInInputSchema>
): Promise<boolean> => {
  const db = consoleDatabase(env.DB);
  const { clientId, signIn } = signInInputSchema.parse(input);
  const parsed = clientSignInSchema.safeParse(signIn);
  if (!parsed.success) {
    const unreachable = parsed.error.issues.some(
      (issue) =>
        issue.code === "custom" && issue.params?.code === adminUnreachable
    );
    throw new SettingsError(
      unreachable ? adminUnreachable : "sign_in_invalid",
      `${clientId}'s sign-in isn't one it can be given`
    );
  }
  await assertClient(db, clientId);
  const value = JSON.stringify(parsed.data);
  const now = new Date();
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ signIn: value, configChangedAt: now, updatedAt: now })
      .where(
        and(
          eq(clients.id, clientId),
          or(isNull(clients.signIn), ne(clients.signIn, value))
        )
      ),
    {
      action: "client.sign_in",
      clientId,
      detail: {
        domains: parsed.data.domains.join(","),
        admins: parsed.data.admins.length,
        ...(parsed.data.entraTenantId === undefined
          ? {}
          : { entraTenantId: parsed.data.entraTenantId }),
        ...(parsed.data.googleHostedDomain === undefined
          ? {}
          : { googleHostedDomain: parsed.data.googleHostedDomain }),
      },
    }
  );
};
