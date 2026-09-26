import type { PermissionRequest } from "@grasp-os/shared/permissions";

import type { signedInApi } from "./sign-in.ts";

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
