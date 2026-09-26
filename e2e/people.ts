/**
 * Signed-in people for end-to-end tests. Sign-in itself goes to Microsoft
 * or Google, which a local stack can't reach, so this writes what a
 * finished sign-in leaves behind straight into core's local database: a
 * person, their membership and a session, and signs the session cookie
 * with the test stack's secret, as Better Auth does.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

import type { Role } from "@grasp-os/shared/roles";
import type { CoreApi } from "@grasp-os/shared/rpc";
import type { BrowserContext } from "@playwright/test";
import { newWebSocketRpcSession } from "capnweb";

/** The local stack's address (playwright.config.ts). */
export const origin = "http://localhost:8787";

/** Signs session cookies on the test stack only; never a real secret. */
export const testAuthSecret = "e2e-only-better-auth-secret-of-32-chars-or-more";

/** The test stack's sign-in config: enough for sessions, no IdP. */
export const testSignIn = { origin, domains: ["acme.test"] };

const sessionCookie = "__Host-grasp.session_token";
const organizationId = "organization";
const coreDirectory = path.join(import.meta.dirname, "../apps/core");
const wrangler = path.join(
  import.meta.dirname,
  "../node_modules/.bin/wrangler"
);

const quoted = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Runs SQL on core's local database, the one the stack's dev server uses. */
const execute = (sql: string): void => {
  execFileSync(wrangler, ["d1", "execute", "DB", "--local", "--command", sql], {
    cwd: coreDirectory,
    stdio: "pipe",
  });
};

/** Better Auth's signed cookie value: the token and its HMAC-SHA256. */
const signed = async (token: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(testAuthSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token)
  );
  return `${token}.${Buffer.from(signature).toString("base64")}`;
};

export interface Person {
  userId: string;
  role: Role;
  /** The session cookie's value. */
  cookie: string;
}

/** People signed in with these roles, by name, one session each. */
export const signedIn = async <Name extends string>(
  roles: Record<Name, Role>
): Promise<Record<Name, Person>> => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const people = Object.entries<Role>(roles).map(([name, role]) => ({
    name,
    role,
    userId: crypto.randomUUID(),
    token: crypto.randomUUID(),
  }));
  execute(
    [
      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES (${quoted(organizationId)}, 'Acme', 'acme', ${now})`,
      ...people.flatMap(({ role, userId, token }) => [
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (${quoted(userId)}, 'Person', ${quoted(`${userId}@acme.test`)}, 1, ${now}, ${now})`,
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (${quoted(crypto.randomUUID())}, ${quoted(organizationId)}, ${quoted(userId)}, ${quoted(role)}, ${now})`,
        `INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at, staff) VALUES (${quoted(crypto.randomUUID())}, ${quoted(token)}, ${quoted(userId)}, ${now + hour}, ${now}, ${now}, 0)`,
      ]),
    ].join("; ")
  );
  const signedPeople = await Promise.all(
    people.map(async ({ name, role, userId, token }) => [
      name,
      { role, userId, cookie: await signed(token) },
    ])
  );
  // SAFETY: one entry for each name in `roles`, as built above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return Object.fromEntries(signedPeople) as Record<Name, Person>;
};

/** Gives a browser context the person's session. */
export const signInTo = async (
  context: BrowserContext,
  person: Person
): Promise<void> => {
  await context.addCookies([
    {
      name: sessionCookie,
      value: encodeURIComponent(person.cookie),
      // Chrome sends Secure cookies to http://localhost too; the cookie
      // store takes one only for a secure URL.
      url: "https://localhost",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
};

/** The person's API over `/rpc`, from Node, as their browser would open it. */
export const apiOf = (person: Person) => {
  const url = new URL("/rpc", origin);
  url.protocol = "ws:";
  const headers = {
    origin,
    cookie: `${sessionCookie}=${encodeURIComponent(person.cookie)}`,
  };
  // SAFETY: Node's WebSocket (undici) takes `{ headers }` as its second
  // argument, which the DOM's types, loaded for page code, don't know.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const socket = new WebSocket(url, { headers } as never);
  const core = newWebSocketRpcSession<CoreApi>(socket);
  return { core, api: core.authenticate() };
};
