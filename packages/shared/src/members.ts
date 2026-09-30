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

/** The longest a team's name may be. */
export const teamNameMaxLength = 100;

/**
 * The organization's members and teams, over `/rpc`, for admins only (never
 * Grasp staff): offboarding, roles and teams. Removing someone is for good:
 * every session they have ends, their open connections close on their next
 * call, their personal connections are disconnected, they leave every team,
 * and signing in again doesn't bring them back. Every change is audited.
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
  /**
   * Makes a team called `name` (trimmed; at most {@link teamNameMaxLength}
   * characters, none of them control or text-direction characters), with
   * nobody in it yet. Refused when another team has the name, whatever its
   * case.
   */
  createTeam: (name: string) => Promise<{ id: string }>;
  /** Gives the team `teamId` another name, under the same rules. */
  renameTeam: (teamId: string, name: string) => Promise<void>;
  /**
   * Deletes the team `teamId`, and with it who was in it and what was
   * shared with it: Apps and collections. A decision waiting on the team
   * reaches nobody, and times out.
   */
  deleteTeam: (teamId: string) => Promise<void>;
  /** Puts the member `userId` in the team `teamId`; no change if they are in it. */
  addTeamMember: (teamId: string, userId: string) => Promise<void>;
  /** Takes the member `userId` out of the team `teamId`; no change if they aren't in it. */
  removeTeamMember: (teamId: string, userId: string) => Promise<void>;
}

/** Why an admin's change to a member or a team was refused or not finished. */
export const memberErrors = defineErrorFamily({
  "member.not_found": "There's no such member.",
  "member.team_not_found": "There's no such team.",
  "member.team_name_invalid": `A team needs a name of at most ${teamNameMaxLength} characters, in plain text.`,
  "member.team_name_taken": "Another team has that name already.",
  "member.self":
    "You can't remove yourself or end your own sessions here. Ask another admin, or sign out.",
  "member.connections_pending":
    "They're removed, but not all their personal connections could be disconnected yet. This is retried automatically, or remove them again.",
  "member.role_invalid": "That isn't a role here.",
  "member.role_changed":
    "Another admin changed their role at the same time. Check it, and try again.",
  "member.last_admin":
    "The organization needs at least one admin. Make someone else an admin first.",
});
