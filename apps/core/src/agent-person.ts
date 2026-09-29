import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Permission } from "@grasp-os/shared/permissions";

import { auditedCall, chatAuthority, requireOpenRun } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { memberOf } from "./auth/identity.ts";
import type { Member } from "./auth/identity.ts";
import { forSandbox } from "./bindings.ts";
import type { Feature } from "./features.ts";
import { requireFeature } from "./features.ts";
import { grantedPermissions } from "./permissions.ts";

// Reads of a chat's code that go through the functions of the person's own
// session (Apps, workflows): as the chat's person, read now, so the agent
// sees no more of them than they would, and only once the agent holds a
// permission for it, as for everything an agent reaches.

/** One read of the chat's code, as `asPerson` runs it. */
export interface PersonRead<T> {
  /** The feature it belongs to: switched off, it reads nothing. */
  feature: Feature;
  /** Whether the agent's permissions, read now, allow it. */
  allowed: (permissions: Permission[]) => boolean;
  /** The API and method, for the audit log. */
  method: string;
  read: (person: Member, permissions: Permission[]) => Promise<T>;
  /** Identifiers and counts for the audit log, never what was read. */
  detail?: (result: T) => Record<string, AuditDetailValue>;
}

/** The permission a read refuses without. */
export const readDenied = () =>
  permissionErrors.create("permission.denied", { action: "read" });

/**
 * Runs one read as the chat's person, once the run's check passed and the
 * agent holds a permission for it, and audits it as `agent.call` however
 * it ends: a refusal too, with why. Errors as the sandbox sees them.
 */
export const asPerson = async <T>(
  env: Env,
  scope: AgentScope,
  { feature, allowed, method, read, detail }: PersonRead<T>
): Promise<T> => {
  await requireOpenRun(env, scope, method);
  try {
    return await auditedCall(
      env,
      scope,
      { method, ...(detail === undefined ? {} : { detailOf: detail }) },
      async () => {
        requireFeature(env, feature);
        const permissions = await grantedPermissions(env, chatAuthority(scope));
        if (!allowed(permissions)) {
          throw readDenied();
        }
        const person = await memberOf(env.DB, scope.personId);
        if (person === undefined) {
          throw permissionErrors.create("permission.person_inactive");
        }
        return await read(person, permissions);
      }
    );
  } catch (error) {
    throw forSandbox(error);
  }
};
