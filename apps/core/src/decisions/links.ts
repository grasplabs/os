import { decisionErrors } from "@grasp-os/shared/decisions";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { z } from "zod";

import { derivedHmacKey } from "../derived-keys.ts";

// Decision links (threat model R8, WF1 to WF4). A link names one decision
// and the one person it was sent to, until the decision's deadline, signed
// with a key only core holds: `/decisions/<id>?link=<token>`, the token
// being `base64url(JSON claims) "." base64url(HMAC-SHA256)`. It is never a
// bearer token: opening it only shows the page (GET answers nothing), and
// answering needs that person's own session, and them still being one the
// decision is from. A link from another person's mail, an edited one or
// one past its deadline is refused. Single use comes with the decision:
// the first answer closes it, so no link answers it again.

/** Keeps a MAC made here from passing for any other use of the key. */
const keyPurpose = "grasp-os decision link v1";

/** The longest token taken, well above any core makes. */
const maxTokenLength = 1024;

const tokenPattern = /^(?<payload>[A-Za-z0-9_-]+)\.(?<mac>[A-Za-z0-9_-]+)$/u;

/** What a link says. Unknown fields make it invalid. */
const claimsSchema = z.strictObject({
  v: z.literal(1),
  /** The decision. */
  d: z.string().min(1),
  /** The person it was sent to. */
  p: z.string().min(1),
  /** When it stops working, in milliseconds since the epoch. */
  exp: z.int().nonnegative(),
});
type LinkClaims = z.infer<typeof claimsSchema>;

const linkKey = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  usage: "sign" | "verify"
): Promise<CryptoKey> => await derivedHmacKey(env, keyPurpose, [usage]);

/** The token of a link to `decision` for `userId`, until `expiresAt`. */
export const signDecisionLink = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  decision: string,
  userId: string,
  expiresAt: number
): Promise<string> => {
  const claims: LinkClaims = { v: 1, d: decision, p: userId, exp: expiresAt };
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const mac = await crypto.subtle.sign(
    "HMAC",
    await linkKey(env, "sign"),
    new TextEncoder().encode(payload)
  );
  return `${payload}.${toBase64Url(new Uint8Array(mac))}`;
};

const invalid = () => decisionErrors.create("decision.link_invalid");

/** The claims of `token`, if core signed it; throws otherwise. */
const readClaims = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  token: unknown
): Promise<LinkClaims> => {
  const parts =
    typeof token === "string" && token.length <= maxTokenLength
      ? tokenPattern.exec(token)
      : null;
  const payload = parts?.groups?.payload;
  const mac = parts?.groups?.mac;
  if (payload === undefined || mac === undefined) {
    throw invalid();
  }
  let valid = false;
  try {
    // Constant time: `verify` compares the MACs itself.
    valid = await crypto.subtle.verify(
      "HMAC",
      await linkKey(env, "verify"),
      fromBase64Url(mac),
      new TextEncoder().encode(payload)
    );
  } catch {
    throw invalid();
  }
  if (!valid) {
    throw invalid();
  }
  try {
    const json = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(fromBase64Url(payload));
    return claimsSchema.parse(JSON.parse(json));
  } catch {
    throw invalid();
  }
};

/**
 * Checks that `token` is a link core made to `decision`, for `userId`,
 * still before its deadline; throws `decision.link_invalid` otherwise.
 */
export const verifyDecisionLink = async (
  env: Pick<Env, "BETTER_AUTH_SECRET">,
  token: unknown,
  decision: string,
  userId: string,
  now: number = Date.now()
): Promise<void> => {
  const claims = await readClaims(env, token);
  if (claims.d !== decision || claims.p !== userId || now >= claims.exp) {
    throw invalid();
  }
};
