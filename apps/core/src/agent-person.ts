import type { AuditDetailValue } from "@grasp-os/shared/audit";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Permission } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  auditAgentCall,
  chatAuthority,
  requireOpenRun,
} from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { memberRole, teamsOf } from "./auth/identity.ts";
import { forSandbox } from "./bindings.ts";
import { users } from "./db/core/schema.ts";
import type { Feature } from "./features.ts";
import { requireFeature } from "./features.ts";
import { grantedPermissions } from "./permissions.ts";

// Reads of a chat's code that go through the functions of the person's own
// session (Apps, workflows): as the chat's person, read now, so the agent
// sees no more of them than they would, and only once the agent holds a
// permission for it, as for everything an agent reaches.

/**
 * The chat's person as their own session would have them, read now.
 * Throws `permission.person_inactive` once they are no longer a member.
 */
const personIdentity = async (env: Env, userId: string): Promise<Identity> => {
  const [role, teams, user] = await Promise.all([
    memberRole(env.DB, userId),
    teamsOf(env.DB, userId),
    drizzle(env.DB)
      .select({ email: users.email, name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .get(),
  ]);
  if (role === undefined || user === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return {
    userId,
    email: user.email,
    name: user.name,
    role,
    teams,
    staff: false,
    // Nothing here reads it: the agent has no session of its own.
    expiresAt: new Date().toISOString(),
  };
};

/** One read of the chat's code, as `asPerson` runs it. */
export interface PersonRead<T> {
  /** The feature it belongs to: switched off, it reads nothing. */
  feature: Feature;
  /** Whether the agent's permissions, read now, allow it. */
  allowed: (permissions: Permission[]) => boolean;
  /** The API and method, for the audit log. */
  method: string;
  read: (person: Identity, permissions: Permission[]) => Promise<T>;
  /** Identifiers and counts for the audit log, never what was read. */
  detail?: (result: T) => Record<string, AuditDetailValue>;
}

/** The permission a read refuses without. */
export const readDenied = () =>
  permissionErrors.create("permission.denied", { action: "read" });

/**
 * Runs one read as the chat's person, once the run's check passed and the
 * agent holds a permission for it, then audits it as `agent.call`. Errors
 * as the sandbox sees them.
 */
export const asPerson = async <T>(
  env: Env,
  scope: AgentScope,
  { feature, allowed, method, read, detail }: PersonRead<T>
): Promise<T> => {
  await requireOpenRun(env, scope);
  try {
    requireFeature(env, feature);
    const permissions = await grantedPermissions(env, chatAuthority(scope));
    if (!allowed(permissions)) {
      throw readDenied();
    }
    const person = await personIdentity(env, scope.personId);
    const result = await read(person, permissions);
    await auditAgentCall(env, scope, {
      method,
      detail: detail?.(result) ?? {},
    });
    return result;
  } catch (error) {
    throw forSandbox(error);
  }
};
