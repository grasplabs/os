import type { Permission } from "@grasp-os/shared/permissions";

import { appsReadableBy } from "./app-access.ts";
import { appsListedFor } from "./apps.ts";
import type { Member } from "./auth/identity.ts";
import { featureEnabled } from "./features.ts";
import { listPermissions } from "./permissions.ts";

// The permissions a person may see: the one filter every reader of them
// goes by (the permissions API, a version's review), so none shows more
// than another.

/**
 * The permissions `by` may see, of `subject` and in `status` when given
 * (`listPermissions`): each naming only Apps they have a role in
 * (`appsListedFor`), and, while `app_sharing` is on, may open now: one
 * that read what they can't read (`app.unreadable`) shows none of its
 * permissions either. Each App named is checked once.
 */
export const permissionsOpenTo = async (
  env: Env,
  by: Member,
  subject?: unknown,
  status?: unknown
): Promise<Permission[]> => {
  const listed = await listPermissions(
    env,
    by,
    subject,
    appsListedFor(env, by),
    status
  );
  if (!featureEnabled(env, "app_sharing")) {
    return listed;
  }
  const named = listed.flatMap(({ subject: of, object }) => [
    ...(of.type === "app" ? [of.appId] : []),
    ...(object.type === "workflow" || object.type === "app"
      ? [object.appId]
      : []),
  ]);
  const readable = await appsReadableBy(env, by, [...new Set(named)]);
  return listed.filter(
    ({ subject: of, object }) =>
      (of.type !== "app" || readable.has(of.appId)) &&
      ((object.type !== "workflow" && object.type !== "app") ||
        readable.has(object.appId))
  );
};
