import type { Permission } from "@grasp-os/shared/permissions";

import { appsFoundBy, appsReadableBy } from "./app-access.ts";
import type { Member } from "./auth/identity.ts";
import { listPermissions } from "./permissions.ts";

// The permissions a person may see: the one filter every reader of them
// goes by (the permissions API, a version's review), so none shows more
// than another.

/**
 * The permissions `by` may see, of `subject` and in `status` when given
 * (`listPermissions`): each naming only Apps they have a role in
 * (`appsFoundBy`) and may open now: one
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
    appsFoundBy(env, by),
    status
  );
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
