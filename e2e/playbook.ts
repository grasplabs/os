import type { apiOf } from "./people.ts";

// The Playbook's built-ins in the end-to-end tests: its record types are
// one App's (core's knowledge/record-types.ts), so a test that creates a
// new copy of the workflow map or the board page hands the Playbook to it,
// as an admin would, choosing the one copy they want. The tests that do
// run one at a time (their own project, playwright.config.ts).

/**
 * Revokes, as `api`'s admin, the collection permissions of every other App
 * created from the built-in `blueprint` but `keep`.
 */
export const revokeOtherCopies = async (
  api: ReturnType<typeof apiOf>["api"],
  blueprint: string,
  keep: string
): Promise<void> => {
  const listed = await api.apps.list();
  const others = new Set(
    listed
      .filter(({ id, blueprint: from }) => id !== keep && from === blueprint)
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
