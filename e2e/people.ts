/**
 * Signed-in people for end-to-end tests. Sign-in itself goes to Microsoft
 * or Google, which a local stack can't reach, so this writes what a
 * finished sign-in leaves behind straight into core's local database: a
 * person, their membership and a session, and signs the session cookie
 * with the test stack's secret, as Better Auth does. It writes them all
 * up front, before any test runs; tests only look theirs up.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { Role } from "@grasp-os/shared/roles";
import type { CoreApi } from "@grasp-os/shared/rpc";
import { test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
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

export const quoted = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

/**
 * How often `execute` tries statements the database was too busy for: it
 * shares the file with the dev server, which may still be settling.
 * It waits between tries, 200 ms first and twice as long each time after,
 * so the lock holder can finish: 3 s at most in all.
 */
const busyAttempts = 5;
const firstBusyWaitMs = 200;

/**
 * What wrangler prints when another connection held the file: SQLite's
 * "database is locked: SQLITE_BUSY", also when its runtime can't start
 * while another process recovers the file, or workerd's opaque "internal
 * error; reference = …" when the batch fails under the same contention.
 * Any other error, a constraint failing say, is the test's to see.
 */
const busyErrors = ["SQLITE_BUSY", "internal error; reference ="];

const isBusy = (error: unknown): boolean =>
  error instanceof Error &&
  "stderr" in error &&
  busyErrors.some((text) => String(error.stderr).includes(text));

/**
 * Where each local database of the stack is, as wrangler options run from
 * core's directory: core's own, and connect's, which the dev server keeps
 * next to it (apps/core/package.json).
 */
const databases = {
  core: [],
  connect: [
    "-c",
    "../connect/wrangler.jsonc",
    "--persist-to",
    ".wrangler/state",
  ],
} as const;

/**
 * Runs SQL on one of the local databases the stack's dev server uses,
 * core's unless `database` says otherwise. Wrangler runs the statements as
 * one batch in one transaction, which SQLite undoes whole when it can't
 * finish, so a busy batch is tried again. Should one ever commit and still
 * report failure, trying it again inserts the same keys and fails on them,
 * rather than writing twice.
 */
export const execute = async (
  sql: string,
  database: keyof typeof databases = "core"
): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      execFileSync(
        wrangler,
        [
          "d1",
          "execute",
          "DB",
          "--local",
          ...databases[database],
          "--command",
          sql,
        ],
        {
          cwd: coreDirectory,
          stdio: "pipe",
          // Test writes aren't usage worth reporting, and every call sent it.
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        }
      );
      return;
    } catch (error) {
      if (attempt >= busyAttempts || !isBusy(error)) {
        throw error;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- one try at a time
    await sleep(firstBusyWaitMs * 2 ** (attempt - 1));
  }
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

/**
 * Everyone the tests sign in as, by scene: a test, or a file whose tests
 * share them. Scenes don't share people, so what a test changes about
 * someone, their role say, no other test sees.
 */
const cast = {
  apps: { builder: "builder", user: "user", admin: "admin" },
  screens: { one: "builder", two: "builder" },
  screenWorkflows: { builder: "builder", admin: "admin" },
  decisionAnswered: { builder: "builder", decider: "user", other: "admin" },
  decisionUnreachable: { decider: "user" },
  memberActions: { admin: "admin", one: "user", two: "user" },
  roleChange: { admin: "admin", one: "user" },
  membersUnreachable: { admin: "admin" },
  membersRecover: { admin: "admin" },
  connections: { admin: "admin", user: "user" },
} as const satisfies Record<string, Record<string, Role>>;

type Scene = keyof typeof cast;

/** Each attempt's people, by scene and name. */
export type Cast = Record<string, Record<string, Person>>[];

/** How `signInCast` hands everyone to the test workers. */
const castVariable = "E2E_CAST";

/**
 * Signs in the whole cast in one write, once for each attempt a test may
 * get, so a retry starts from people as they were, not as the failed
 * attempt left them. The global setup (e2e/setup.ts) runs it before any
 * test loads a page, and returns them. Writing from a process of its own while the dev
 * server reads the same file can fail the dev server's query with
 * SQLITE_BUSY, so no test writes people while tests run.
 */
export const signInCast = async (attempts: number): Promise<Cast> => {
  const now = Date.now();
  // Covers the slowest run, also against a stack that was already running.
  const day = 24 * 60 * 60 * 1000;
  const people = Array.from({ length: attempts }, (_, attempt) =>
    Object.entries(cast).flatMap(([scene, roles]) =>
      Object.entries<Role>(roles).map(([name, role]) => ({
        attempt,
        scene,
        name,
        role,
        userId: crypto.randomUUID(),
        token: crypto.randomUUID(),
      }))
    )
  ).flat();
  await execute(
    [
      `INSERT OR IGNORE INTO organizations (id, name, slug, created_at) VALUES (${quoted(organizationId)}, 'Acme', 'acme', ${now})`,
      ...people.flatMap(({ role, userId, token }) => [
        `INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (${quoted(userId)}, 'Person', ${quoted(`${userId}@acme.test`)}, 1, ${now}, ${now})`,
        `INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (${quoted(crypto.randomUUID())}, ${quoted(organizationId)}, ${quoted(userId)}, ${quoted(role)}, ${now})`,
        `INSERT INTO sessions (id, token, user_id, expires_at, created_at, updated_at, staff) VALUES (${quoted(crypto.randomUUID())}, ${quoted(token)}, ${quoted(userId)}, ${now + day}, ${now}, ${now}, 0)`,
      ]),
    ].join("; ")
  );
  const signedIn: Cast = Array.from({ length: attempts }, () => ({}));
  for (const { attempt, scene, name, role, userId, token } of people) {
    const scenes = signedIn[attempt] ?? {};
    scenes[scene] ??= {};
    // oxlint-disable-next-line no-await-in-loop -- signing takes microseconds
    scenes[scene][name] = { role, userId, cookie: await signed(token) };
  }
  // Playwright hands the global setup's environment to the test workers.
  process.env[castVariable] = JSON.stringify(signedIn);
  return signedIn;
};

/** The scene's people, signed in for this attempt at the running test. */
export const peopleIn = <S extends Scene>(
  scene: S
): Record<keyof (typeof cast)[S], Person> => {
  const { retry } = test.info();
  const json = process.env[castVariable];
  if (json === undefined) {
    throw new Error(
      `${castVariable} is unset: the global setup in playwright.config.ts signs people in`
    );
  }
  // SAFETY: signInCast wrote it, as a Cast.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const people = (JSON.parse(json) as Cast)[retry]?.[scene];
  if (people === undefined) {
    throw new Error(`Nobody is signed in for ${scene}, attempt ${retry + 1}`);
  }
  // SAFETY: signInCast signed in every name in the scene's cast.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return people as Record<keyof (typeof cast)[S], Person>;
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

/** A page signed in as `person`, in a browser context of its own. */
export const pageOf = async (
  browser: Browser,
  person: Person
): Promise<Page> => {
  const context = await browser.newContext();
  await signInTo(context, person);
  return await context.newPage();
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

/**
 * Writes `files` to the App (null deletes one), commits them and makes
 * that version current.
 */
export const release = async (
  api: ReturnType<typeof apiOf>["api"],
  app: string,
  files: Record<string, string | null>,
  message: string
): Promise<void> => {
  await api.apps.files.write(app, files);
  const { version } = await api.apps.files.commit(app, message);
  await api.apps.versions.setCurrent(app, version);
};
