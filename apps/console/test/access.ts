/**
 * A stand-in for Cloudflare Access: it serves the team's signing keys at
 * their real URL, so the console verifies JWTs exactly as in production,
 * and signs the JWTs Access would put on a staff member's requests. A test
 * can also sign what Access never would: other audiences, other issuers,
 * other keys, expired tokens, service tokens without an email.
 */
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import { afterEach, beforeEach, vi } from "vite-plus/test";

import { accessTeam } from "./access-config.ts";

const algorithm = "RS256";
const keyId = "access-test-key";

const teamKeys = await generateKeyPair(algorithm, { extractable: true });
/** A key Access never published: what an attacker could sign with. */
const strangerKeys = await generateKeyPair(algorithm);

const publicJwk = await exportJWK(teamKeys.publicKey);
const certsUrl = `${accessTeam.issuer}/cdn-cgi/access/certs`;

interface Signing {
  /** Claims to add or override (`aud`, `iss` and `email` included). */
  claims?: JWTPayload;
  /** Seconds from now until it expires; negative for an expired JWT. */
  expiresIn?: number;
  /** Signs with a key Access never published. */
  stranger?: boolean;
}

/** A JWT as Access issues it to `email`, changed as `signing` says. */
export const accessJwt = async (
  email: string,
  { claims = {}, expiresIn = 3600, stranger = false }: Signing = {}
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    email,
    sub: `sub-${email}`,
    iss: accessTeam.issuer,
    aud: [accessTeam.audience],
    ...claims,
  })
    .setProtectedHeader({ alg: algorithm, kid: keyId })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(stranger ? strangerKeys.privateKey : teamKeys.privateKey);
};

/**
 * Serves the team's keys to the console for each test in the file. Any
 * other request goes to the stand-in for `fetch` the file set up before
 * this one (the fake Cloudflare API, test/cloudflare-api.ts), if it has
 * one; without one it's refused.
 */
export const mockAccess = (): void => {
  beforeEach(() => {
    const stoodIn = vi.isMockFunction(globalThis.fetch);
    const earlier = stoodIn
      ? vi.mocked(globalThis.fetch).getMockImplementation()
      : undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const { url } = new Request(input, init);
      if (url === certsUrl) {
        return Response.json({
          keys: [{ ...publicJwk, kid: keyId, alg: algorithm, use: "sig" }],
        });
      }
      if (earlier === undefined) {
        throw new Error(`Unexpected outbound request to ${url}`);
      }
      return await earlier(input, init);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
};
