import { defineErrorFamily } from "./errors.ts";
import type { Role } from "./roles.ts";

/** A person in the organization, as admins see them. */
export interface Member {
  userId: string;
  name: string;
  email: string;
  role: Role;
  /** When they first signed in (ISO 8601). */
  joinedAt: string;
}

/**
 * The organization's members, over `/rpc`, for admins only (never Grasp
 * staff): offboarding. Removing someone is for good: every session they
 * have ends, their open connections close on their next call, their
 * personal connections are disconnected, and signing in again doesn't
 * bring them back.
 */
export interface MembersApi {
  list: () => Promise<Member[]>;
  /**
   * Removes the member with `userId`. Removing someone already removed
   * finishes what the first removal left undone (disconnecting their
   * personal connections), so it is safe to try again.
   */
  remove: (userId: string) => Promise<{ connectionsDisconnected: number }>;
  /** Ends every session of the member with `userId`, who stays a member. */
  revokeSessions: (userId: string) => Promise<void>;
  /**
   * Gives the member with `userId` `role`. Refused when it would leave the
   * organization without an admin.
   */
  setRole: (userId: string, role: Role) => Promise<void>;
}

/** Why an admin's change to a member was refused or not finished. */
export const memberErrors = defineErrorFamily({
  "member.not_found": "There's no such member.",
  "member.self":
    "You can't remove yourself or end your own sessions here. Ask another admin, or sign out.",
  "member.connections_pending":
    "They're removed, but not all their personal connections could be disconnected yet. This is retried automatically, or remove them again.",
  "member.role_invalid": "That isn't a role here.",
  "member.last_admin":
    "The organization needs at least one admin. Make someone else an admin first.",
});
