import { appIdSchema } from "@grasp-os/shared/ids";
import type {
  GrantReview,
  Permission,
  PermissionRequest,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { vi } from "vite-plus/test";

import { versionFiles } from "../src/apps.ts";
import { buildServer } from "../src/screens.ts";
import type { Idp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

/**
 * How soon a screen stops hearing from an App once its person lost access
 * to it: the platform promises within seconds, and checks again every 5 s.
 */
const promisedWithinMs = 5000;

/**
 * What `run` returns, run with core's clock `promisedWithinMs` on: past
 * the time the last answer to whether someone may still use an App holds,
 * so the next push to their screen checks again. Waiting that out for real
 * took five seconds a test, and raced a loaded runner. Tests wait at most
 * 3 s for the push that is refused, so only the moved clock can get there.
 */
export const pastAccessRecheck = async <T>(
  run: () => Promise<T>
): Promise<T> => {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + promisedWithinMs });
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
};

/** Someone signed in, with their API (`signedInApi`). */
type Builder = Pick<Awaited<ReturnType<typeof signedInApi>>, "api">;

/** Commits `files` as the App's next version and makes it current. */
export const release = async (
  builder: Builder,
  app: string,
  files: Record<string, string | null>
): Promise<number> => {
  await builder.api.apps.files.write(app, files);
  const { version } = await builder.api.apps.files.commit(app, "Release");
  await builder.api.apps.versions.setCurrent(app, version);
  return version;
};

/**
 * Builds the server code of the App's `version` into the build cache, as
 * its first call would. A call's deadline covers starting the code, build
 * included, and tests shorten that deadline to 10 seconds
 * (`APP_CALL_TIMEOUT_MS`, vite.config.ts), which a build on a loaded
 * runner can take longer than. Built ahead, a first call only loads it.
 */
export const serverBuilt = async (
  app: string,
  version: number
): Promise<void> => {
  const id = appIdSchema.parse(app);
  const build = await buildServer(env, await versionFiles(env, id, version));
  if (!build.ok) {
    throw new Error(`Version ${version} of the App doesn't build`);
  }
};

/** Outlook, as a connection the App may be given. */
export const outlook = (
  app: string,
  binding = "OUTLOOK"
): PermissionRequest => ({
  subject: { type: "app", appId: app },
  object: { type: "connection", connectionId: "connection-outlook" },
  actions: ["mail.list"],
  binding,
});

/** An admin's API (`signedInApi`). */
type Api = Awaited<ReturnType<typeof signedInApi>>["api"];

/**
 * What an admin reviews as they grant the permission `id`: the version of
 * its App current now, or none for an agent's, or an App with none
 * current (`PermissionsApi.grant`).
 */
export const reviewedOf = async (
  api: Api,
  id: string
): Promise<GrantReview> => {
  const listed = await api.permissions.list();
  const subject = listed.find((permission) => permission.id === id)?.subject;
  if (subject?.type !== "app") {
    return { version: null };
  }
  const apps = await api.apps.list();
  const app = apps.find(({ id: appId }) => appId === subject.appId);
  return { version: app?.currentVersion ?? null };
};

/**
 * Revokes, as `api`'s admin, the collection permissions of every other App
 * created from the built-in `blueprint` but `keep`: a collection's record
 * types are one App's (knowledge/record-types.ts), so a test that creates
 * a new copy of a built-in hands them to it, as an admin would, choosing
 * the one copy they want.
 */
export const revokeOtherCopies = async (
  api: Api,
  blueprint: string,
  keep: string
): Promise<void> => {
  const listed = await api.apps.list();
  const others = new Set(
    listed
      .filter(
        ({ id, blueprint: from }) =>
          id !== keep && from?.startsWith(`${blueprint}@`) === true
      )
      .map(({ id }) => id)
  );
  const permissions = await api.permissions.list();
  for (const { id, subject, object, status } of permissions) {
    if (
      subject.type === "app" &&
      others.has(subject.appId) &&
      object.type === "collection" &&
      status !== "revoked"
    ) {
      // oxlint-disable-next-line no-await-in-loop -- one revoke at a time
      await api.permissions.revoke(id);
    }
  }
};

/** Grants the permission `id` as `api`'s admin, having reviewed it now. */
export const grantReviewed = async (
  api: Api,
  id: string
): Promise<Permission> =>
  await api.permissions.grant(id, await reviewedOf(api, id));

/**
 * Asks for `request` as `requester`, who may be a builder, and has an
 * admin, signed in for it, grant it. Returns its ID.
 */
export const requestGranted = async (
  idp: Idp,
  requester: Builder,
  request: PermissionRequest
): Promise<string> => {
  const { id } = await requester.api.permissions.request(request);
  const admin = await signedInApi(idp, "admin");
  try {
    await grantReviewed(admin.api, id);
  } finally {
    admin.core[Symbol.dispose]();
  }
  return id;
};

/**
 * Core's database, with `first` run once, just before the first batch
 * after a statement that `writes` matches was prepared lands: another
 * writer getting there first.
 */
export const racingDb = (
  first: () => Promise<unknown>,
  writes: RegExp
): D1Database => {
  const real = env.DB;
  let writing = false;
  let raced = false;
  return {
    prepare: (query) => {
      writing ||= writes.test(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      if (writing && !raced) {
        raced = true;
        await first();
      }
      return await real.batch<T>(statements);
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
};
