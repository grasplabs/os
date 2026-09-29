import type { Role } from "@grasp-os/shared/roles";
import type { CoreApi } from "@grasp-os/shared/rpc";
import { test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { newWebSocketRpcSession } from "capnweb";

/**
 * Signed-in people for end-to-end tests. They sign in through the product,
 * as anyone does: core sends them to the client's Entra tenant, which on
 * the local stack is the fake IdP (apps/core/test/idp-worker.ts), and the
 * IdP sends them back signed in. The configured admin then gives each the
 * role the tests need, through the members API. Everyone is signed in up
 * front, before any test runs; tests only look theirs up.
 */
import { localAdmin } from "../apps/core/test/sign-in-config.ts";

/** The local stack's address (playwright.config.ts). */
export const origin = "http://localhost:8787";

/** Signs session cookies on the test stack only; never a real secret. */
export const testAuthSecret = "e2e-only-better-auth-secret-of-32-chars-or-more";

const sessionCookie = "__Host-grasp.session_token";

/** The `name=value` pairs a response sets, as a `Cookie` header. */
const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

/** Where a redirect goes; fails when the response isn't one. */
const locationOf = (response: Response, step: string): string => {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`${step} did not redirect (${response.status})`);
  }
  return location;
};

/**
 * Signs in as `email` the way a browser does: core starts the sign-in, the
 * IdP (told who by `loginHint`) sends the browser back, and core's callback
 * sets the session cookie. Returns that cookie's value.
 */
const signInAs = async (email: string): Promise<string> => {
  const started = await fetch(new URL("/api/auth/sign-in/sso", origin), {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      providerId: "microsoft",
      callbackURL: "/",
      errorCallbackURL: "/",
      loginHint: email,
    }),
  });
  const body: unknown = await started.json();
  if (
    !started.ok ||
    typeof body !== "object" ||
    body === null ||
    !("url" in body) ||
    typeof body.url !== "string"
  ) {
    throw new Error(`Sign-in as ${email} did not start (${started.status})`);
  }
  const atIdp = await fetch(body.url, { redirect: "manual" });
  const finished = await fetch(locationOf(atIdp, "The IdP"), {
    redirect: "manual",
    headers: { cookie: cookiesOf(started) },
  });
  const session = cookiesOf(finished)
    .split("; ")
    .find((pair) => pair.startsWith(`${sessionCookie}=`));
  if (session === undefined) {
    throw new Error(
      `Sign-in as ${email} refused: ${locationOf(finished, "Core")}`
    );
  }
  return decodeURIComponent(session.slice(sessionCookie.length + 1));
};

export interface Person {
  userId: string;
  email: string;
  role: Role;
  /** The session cookie's value. */
  cookie: string;
}

/** The person's API over `/rpc`, from Node, as their browser would open it. */
export const apiOf = (person: Pick<Person, "cookie">) => {
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
  knowledge: { one: "user", two: "user" },
  knowledgeUploads: { one: "user" },
  knowledgeReader: { admin: "admin", reader: "user" },
  workflowMap: { admin: "admin", reader: "user" },
  boardPage: { admin: "admin" },
  models: { admin: "admin", builder: "builder" },
  workflows: { builder: "builder", user: "user" },
  activity: { admin: "admin", builder: "builder" },
  activityAgain: { admin: "admin", builder: "builder" },
  chat: { user: "user" },
  chatBuilds: { builder: "builder" },
} as const satisfies Record<string, Record<string, Role>>;

type Scene = keyof typeof cast;

/** Each attempt's people, by scene and name. */
export type Cast = Record<string, Record<string, Person>>[];

/** How `signInCast` hands everyone to the test workers. */
const castVariable = "E2E_CAST";

/**
 * Signs in the whole cast, once for each attempt a test may get, so a
 * retry starts from people as they were, not as the failed attempt left
 * them. Everyone is called Person (person.<id>@acme.test, as the IdP names
 * people by their email's first word) and joins as a user; the configured
 * admin then gives the others their roles. The global setup (e2e/setup.ts)
 * runs it before any test, and returns them.
 */
export const signInCast = async (attempts: number): Promise<Cast> => {
  const people = await Promise.all(
    Array.from({ length: attempts }, (_, attempt) =>
      Object.entries(cast).flatMap(([scene, roles]) =>
        Object.entries<Role>(roles).map(([name, role]) => ({
          attempt,
          scene,
          name,
          role,
          email: `person.${crypto.randomUUID()}@acme.test`,
        }))
      )
    )
      .flat()
      .map(async (person) => ({
        ...person,
        cookie: await signInAs(person.email),
      }))
  );
  const { core, api } = apiOf({ cookie: await signInAs(localAdmin) });
  try {
    const members = await api.members.list();
    const userIds = new Map(
      members.map(({ email, userId }) => [email, userId])
    );
    const signedIn = people.map((person) => {
      const userId = userIds.get(person.email);
      if (userId === undefined) {
        throw new Error(`${person.email} signed in but isn't a member`);
      }
      return { ...person, userId };
    });
    await Promise.all(
      signedIn
        .filter(({ role }) => role !== "user")
        .map(async ({ userId, role }) => {
          await api.members.setRole(userId, role);
        })
    );
    const byAttempt: Cast = Array.from({ length: attempts }, () => ({}));
    for (const { attempt, scene, name, ...person } of signedIn) {
      const scenes = byAttempt[attempt] ?? {};
      scenes[scene] ??= {};
      scenes[scene][name] = {
        userId: person.userId,
        email: person.email,
        role: person.role,
        cookie: person.cookie,
      };
    }
    // Playwright hands the global setup's environment to the test workers.
    process.env[castVariable] = JSON.stringify(byAttempt);
    return byAttempt;
  } finally {
    core[Symbol.dispose]();
  }
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
