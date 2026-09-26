import type { ApprovalsApi } from "./approvals.ts";
import type { AppsApi } from "./apps.ts";
import type { AuditApi } from "./audit-log.ts";
import type { ConnectionsApi } from "./connect.ts";
import type { DecisionsApi } from "./decisions.ts";
import type { KnowledgeApi } from "./knowledge.ts";
import type { MembersApi } from "./members.ts";
import type { PermissionsApi } from "./permissions.ts";
import type { Role } from "./roles.ts";
import type { ScreensApi } from "./screens.ts";
import type { WorkflowsApi } from "./workflows.ts";

/** A way to sign in to this deployment, for the sign-in screen. */
export interface SignInOption {
  /** Passed to Better Auth's `POST /api/auth/sign-in/sso` as `providerId`. */
  providerId: string;
  label: string;
}

/** The signed-in person, as the server sees them right now. */
export interface Identity {
  userId: string;
  email: string;
  name: string;
  role: Role;
  /** The teams they belong to. */
  teams: { id: string; name: string }[];
  /** Grasp staff, signed in for a limited time; not a member of the organization. */
  staff: boolean;
  /** When the session ends (ISO 8601). */
  expiresAt: string;
}

/**
 * What a signed-in person reaches. Every call checks the session again, so
 * one that was revoked or expired stops working at once, and the connection
 * closes. Each feature is a namespace of its own (`session.apps.list()`),
 * the same object on every access.
 */
export interface SessionApi {
  /** The person behind the session, with their current role and teams. */
  whoami: () => Promise<Identity>;
  /** Permissions of Apps and agents. */
  readonly permissions: PermissionsApi;
  /** The App registry and each App's code. Admins and builders. */
  readonly apps: AppsApi;
  /** Knowledge: collections, documents and their versions. */
  readonly knowledge: KnowledgeApi;
  /**
   * Accounts connected through OAuth: the person's own, and shared ones
   * (which only admins connect and disconnect).
   */
  readonly connections: ConnectionsApi;
  /** Runs of Apps' workflows. Admins and builders. */
  readonly workflows: WorkflowsApi;
  /**
   * Decisions workflow runs wait for, answered by the people they are
   * from, whatever their role.
   */
  readonly decisions: DecisionsApi;
  /** Apps' screens: their builds, their servers and their error logs. */
  readonly screens: ScreensApi;
  /** The organization's members: offboarding. Admins only. */
  readonly members: MembersApi;
  /** The audit log: search, export and chain verification. Admins only. */
  readonly audit: AuditApi;
  /**
   * Permission grants and sensitive value changes waiting for a second
   * person. Admins and builders.
   */
  readonly approvals: ApprovalsApi;
}

/**
 * The root object core exposes to the frontend over Cap'n Web, at `/rpc`.
 * Core implements it; the frontend holds a typed stub of it.
 */
export interface CoreApi {
  /** Answers `"pong"`: proves the connection works end to end. */
  ping: () => "pong";
  /** The ways to sign in here; empty while sign-in isn't set up. */
  signInOptions: () => SignInOption[];
  /**
   * The signed-in person's API, for the session the connection was opened
   * with. Throws `auth.unauthenticated` when there is none.
   */
  authenticate: () => SessionApi;
}
