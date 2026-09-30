/**
 * A client's settings, as staff change them on its page: its ring and
 * its sign-in (its record's `signIn`, which every deploy makes core's
 * `SIGN_IN` from). Each change is audited in the same batch as the change, and
 * only when it changes something.
 *
 * None of it reaches the client's account at once. The ring decides which
 * rollouts reach it; sign-in is set on core by its next deploy. It also
 * marks the client (`configChangedAt`), so the next rollout
 * deploys it even when it's on the release already (src/rollout/targets.ts).
 */
import { hkdfHmacKey } from "@grasp-os/shared/client-secrets";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { z } from "zod";

import type { Staff } from "../access.ts";
import { actIfChanged, consoleDatabase } from "../db/act.ts";
import type { ConsoleDatabase } from "../db/act.ts";
import { clients } from "../db/schema.ts";
import {
  MissingStoreSecretError,
  signInApps,
  storeSecret,
} from "../deploy/context.ts";
import {
  adminUnreachable,
  clientSignInSchema,
  missingSignInApp,
} from "../deploy/core-config.ts";
import { keyedHash } from "../deploy/upload.ts";

/** Why staff's change to a client's settings was refused, as the page words it. */
export const settingsErrorCodes = [
  /** No such client. */
  "unknown_client",
  /** The sign-in isn't one: no IdP, a domain or email that isn't one. */
  "sign_in_invalid",
  /** The sign-in names no first admin, or one whose email isn't in its domains. */
  adminUnreachable,
  /** The sign-in names an IdP the console has no OAuth app id for (ENTRA_CLIENT_ID, GOOGLE_CLIENT_ID). */
  "sign_in_app_missing",
  /** The client isn't active, so there's nothing live to apply settings to. */
  "not_active",
  /** The client's Workers don't run one release the console made live. */
  "nothing_deployed",
  /** Another runner (provisioning, a rollout, a rollback) has the client. */
  "client_busy",
  /** Secrets Store has no `CLIENT_KEY` to fingerprint a sign-in's admins with. */
  "store_secret_missing",
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

const clientIdSchema = z.string().min(1);

export const ringInputSchema = z.object({
  clientId: clientIdSchema,
  ring: z.int().nonnegative(),
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

/** What the key admins fingerprints are made with is derived for. */
const adminsFingerprintPurpose = "grasp-os console admins fingerprint";

/**
 * A fingerprint of client `clientId`'s first admins, whatever their
 * order: HMAC-SHA256 under a key HKDF derives from `key` (`CLIENT_KEY`)
 * for this purpose alone, as `secretsFingerprint` is made. It tells the
 * audit log that the admins changed, and whether to a list it had before,
 * without naming anyone; with the client's id in it, the same people at
 * two clients don't share one.
 */
const adminsFingerprint = async (
  key: string,
  clientId: string,
  admins: readonly string[]
): Promise<string> =>
  await keyedHash(await hkdfHmacKey(key, adminsFingerprintPurpose, ["sign"]), {
    clientId,
    admins: admins.toSorted(),
  });

/** `CLIENT_KEY`, or null while Secrets Store doesn't have it. */
const clientKey = async (env: Env): Promise<string | null> => {
  try {
    return await storeSecret(env, "CLIENT_KEY");
  } catch (error) {
    if (error instanceof MissingStoreSecretError) {
      return null;
    }
    throw error;
  }
};

/**
 * Sets client `clientId`'s sign-in, as `staff`, audited (`client.sign_in`,
 * with its domains and IdPs, and of its admins, whose emails are personal
 * data, only a count and a keyed fingerprint, `adminsFingerprint`) when
 * it changes. Its
 * next deploy makes core's `SIGN_IN` from it. Refused as the record's own
 * rule refuses it: `admin_unreachable` without a first admin who can sign
 * in, `sign_in_app_missing` for an IdP the console has no app id for,
 * `sign_in_invalid` for anything else. Returns whether it changed.
 *
 * Whether it changes anything is decided once, by the write itself: it
 * changes the record only where the sign-in there differs, whatever
 * another request made of it a moment before. While Secrets Store has no
 * `CLIENT_KEY` to make the fingerprint with, nothing is written, since a
 * change that couldn't say which admins it set isn't made: the same
 * condition is read instead, and a sign-in that differs is refused
 * (`store_secret_missing`), while the one the client has is no change.
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
  const missing = missingSignInApp(parsed.data, signInApps(env));
  if (missing !== null) {
    throw new SettingsError(
      "sign_in_app_missing",
      `The console has no ${missing} app id for ${clientId}'s sign-in`
    );
  }
  await assertClient(db, clientId);
  const value = JSON.stringify(parsed.data);
  /** The client's record, while its sign-in isn't `value` already. */
  const whereItDiffers = and(
    eq(clients.id, clientId),
    or(isNull(clients.signIn), ne(clients.signIn, value))
  );
  const key = await clientKey(env);
  if (key === null) {
    // Nothing is written without the key, so this one read is the whole
    // decision: no change to make, or one that can't be recorded.
    const [differing] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(whereItDiffers);
    if (differing === undefined) {
      return false;
    }
    throw new SettingsError(
      "store_secret_missing",
      `CLIENT_KEY is missing from Secrets Store: ${clientId}'s sign-in can't be changed`
    );
  }
  const admins = await adminsFingerprint(key, clientId, parsed.data.admins);
  const now = new Date();
  return await actIfChanged(
    db,
    staff,
    db
      .update(clients)
      .set({ signIn: value, configChangedAt: now, updatedAt: now })
      .where(whereItDiffers),
    {
      action: "client.sign_in",
      clientId,
      detail: {
        domains: parsed.data.domains.join(","),
        admins: parsed.data.admins.length,
        adminsFingerprint: admins,
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
