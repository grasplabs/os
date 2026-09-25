import { z } from "zod";

import { auditIdentifierMaxLength } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";
import { connectionIdSchema } from "./ids.ts";
import { authoritySchema, permissionActionSchema } from "./permissions.ts";
import type { Authority } from "./permissions.ts";

// A capability is what lets connect act on a call from core without
// trusting core's caller: core checks the permission, then signs exactly
// what it allows (who, for whom, which connection, resource and action,
// which idempotency key) for a few seconds; connect verifies every field
// against the call before it does anything.
//
// The scheme is HMAC-SHA256 with a secret only core and connect hold
// (`CAPABILITY_SIGNING_KEY`), over the token's own payload text:
// `base64url(JSON claims) "." base64url(MAC)`. Both ends are ours and share
// the secret, so a MAC does what a signature would, with less to go wrong.
//
// Replays: connect keeps no record of used capabilities. A capability names
// one exact call and expires quickly, and a side effect is bound to the
// idempotency key it names, so replaying one repeats at most that same call
// within its lifetime, and a write returns its stored result instead of
// running again.

/** How long core makes a capability valid for: one call, not a session. */
export const capabilityTtlMs = 30_000;

/** The longest lifetime connect accepts, however a capability was made. */
export const capabilityMaxTtlMs = 60_000;

/** How far ahead of connect's clock a capability may have been issued. */
export const capabilityClockSkewMs = 5000;

/** The shortest signing key accepted, in characters. */
export const capabilityKeyMinLength = 32;

/** Keeps a MAC made here from ever passing as one made for anything else. */
const macContext = "grasp-os capability v1\n";

const identifier = () => z.string().min(1).max(auditIdentifierMaxLength);

/** What a capability says. Unknown fields make it invalid. */
export const capabilityClaimsSchema = z.strictObject({
  v: z.literal(1),
  /** Only connect accepts it. */
  aud: z.literal("connect"),
  /** Unique per capability, so calls can be told apart in the audit log. */
  jti: z.uuid(),
  /** Issued and expires, in milliseconds since the epoch. */
  iat: z.int().nonnegative(),
  exp: z.int().nonnegative(),
  authority: authoritySchema,
  connectionId: identifier().pipe(connectionIdSchema),
  /** The one resource in the connection it covers, or the whole connection. */
  resource: identifier().nullable(),
  action: permissionActionSchema,
  /** A side effect's key; connect stores its result under it. */
  idempotencyKey: identifier().nullable(),
});
export type CapabilityClaims = z.infer<typeof capabilityClaimsSchema>;

/** The one call a capability is for, as the call itself states it. */
export interface CapabilityScope {
  connectionId: string;
  resource?: string | undefined;
  action: string;
  idempotencyKey?: string | undefined;
}

/** Why connect refuses a call before looking at it any further. */
export const capabilityErrors = defineErrorFamily({
  "capability.invalid":
    "This call doesn't carry a valid capability for this action.",
});

type MacUsage = "sign" | "verify";

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const tokenPattern = /^(?<payload>[A-Za-z0-9_-]+)\.(?<mac>[A-Za-z0-9_-]+)$/u;

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");

const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> => {
  if (!base64UrlPattern.test(text)) {
    throw new TypeError("Not base64url");
  }
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
};

const macKey = async (secret: string, usage: MacUsage): Promise<CryptoKey> => {
  if (secret.length < capabilityKeyMinLength) {
    throw new Error(
      `The capability signing key must be at least ${capabilityKeyMinLength} characters`
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
};

const macInput = (payload: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`${macContext}${payload}`);

/**
 * Makes the capability for one call, valid for {@link capabilityTtlMs}.
 * Core calls it in exactly one place, after the permission check.
 */
export const signCapability = async (
  secret: string,
  authority: Authority,
  scope: CapabilityScope,
  now: number = Date.now()
): Promise<string> => {
  const claims: CapabilityClaims = capabilityClaimsSchema.parse({
    v: 1,
    aud: "connect",
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + capabilityTtlMs,
    authority,
    connectionId: scope.connectionId,
    resource: scope.resource ?? null,
    action: scope.action,
    idempotencyKey: scope.idempotencyKey ?? null,
  });
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await macKey(secret, "sign"),
    macInput(payload)
  );
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
};

const invalid = (reason: "malformed" | "mac" | "expired" | "scope") =>
  capabilityErrors.create("capability.invalid", { reason });

/** Whether one of `keys` made `mac` over `payload`, in constant time each. */
const madeWithOneOf = async (
  keys: readonly CryptoKey[],
  mac: Uint8Array<ArrayBuffer>,
  payload: string
): Promise<boolean> => {
  const checks = await Promise.all(
    keys.map(
      async (key) =>
        await crypto.subtle.verify("HMAC", key, mac, macInput(payload))
    )
  );
  return checks.includes(true);
};

/** The claims, if the MAC over the payload holds; throws otherwise. */
const readClaims = async (
  secrets: readonly string[],
  token: unknown
): Promise<CapabilityClaims> => {
  const parts = typeof token === "string" ? tokenPattern.exec(token) : null;
  const payload = parts?.groups?.payload;
  const mac = parts?.groups?.mac;
  if (payload === undefined || mac === undefined) {
    throw invalid("malformed");
  }
  // The keys are checked before anything else.
  const keys = await Promise.all(
    secrets.map(async (secret) => await macKey(secret, "verify"))
  );
  if (keys.length === 0) {
    throw new Error("No capability signing key to verify with");
  }
  let macBytes: Uint8Array<ArrayBuffer>;
  try {
    macBytes = fromBase64Url(mac);
  } catch {
    throw invalid("malformed");
  }
  if (!(await madeWithOneOf(keys, macBytes, payload))) {
    throw invalid("mac");
  }
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      fromBase64Url(payload)
    );
    return capabilityClaimsSchema.parse(JSON.parse(json));
  } catch {
    throw invalid("malformed");
  }
};

/**
 * Checks a capability against the call it came with: made with one of
 * `secrets` (the current key, and the previous one while a rotation is
 * under way), for connect, still valid, and for exactly this connection,
 * resource, action and idempotency key. Returns what it says (who, for
 * whom, how); throws `capability.invalid` otherwise.
 */
export const verifyCapability = async (
  secrets: readonly string[],
  token: unknown,
  scope: CapabilityScope,
  now: number = Date.now()
): Promise<CapabilityClaims> => {
  const claims = await readClaims(secrets, token);
  const live =
    claims.iat <= now + capabilityClockSkewMs &&
    now < claims.exp &&
    claims.exp - claims.iat <= capabilityMaxTtlMs;
  if (!live) {
    throw invalid("expired");
  }
  const matches =
    claims.connectionId === scope.connectionId &&
    claims.resource === (scope.resource ?? null) &&
    claims.action === scope.action &&
    claims.idempotencyKey === (scope.idempotencyKey ?? null);
  if (!matches) {
    throw invalid("scope");
  }
  return claims;
};
