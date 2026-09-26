import { appIdSchema } from "@grasp-os/shared/ids";
import type { PermissionRequest } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";

import { versionFiles } from "../src/apps.ts";
import { buildServer } from "../src/screens.ts";
import type { Idp } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

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
  const build = await buildServer(env, {
    app: id,
    version: String(version),
    files: await versionFiles(env, id, version),
  });
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
    await admin.api.permissions.grant(id);
  } finally {
    admin.core[Symbol.dispose]();
  }
  return id;
};
