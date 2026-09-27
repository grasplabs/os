import type { AppsApi } from "./apps.ts";
import type { AuditApi } from "./audit-log.ts";
import type { ConnectionsApi, PendingActionsApi } from "./connect.ts";
import type { DecisionsApi } from "./decisions.ts";
import type { KnowledgeApi } from "./knowledge.ts";
import type { MembersApi } from "./members.ts";
import type { MemoryApi } from "./memory.ts";
import type { PermissionsApi } from "./permissions.ts";
import type { Role } from "./roles.ts";
import type { ScreensApi } from "./screens.ts";
import type { SignalsApi } from "./signals.ts";
import type { UploadsApi } from "./uploads.ts";
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
  /**
   * The App registry and each App's code: the Apps the person owns or that
   * are shared with them, and every App for admins.
   */
  readonly apps: AppsApi;
  /** Knowledge: collections, documents and their versions. */
  readonly knowledge: KnowledgeApi;
  /** Memory files: the collections that hold them. */
  readonly memory: MemoryApi;
  /**
   * Files uploaded into Knowledge: uploading one, and following its
   * status as its text is extracted.
   */
  readonly uploads: UploadsApi;
  /**
   * Accounts connected through OAuth: the person's own, and shared ones
   * (which only admins connect and disconnect).
   */
  readonly connections: ConnectionsApi;
  /** Runs of Apps' workflows, for those with a role in the App. */
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
   * Side effects the person's agents, Apps and runs asked for, held until
   * the person confirms or declines them: from chat, from a person using
   * an App, and from any of them once it read restricted data.
   */
  readonly pendingActions: PendingActionsApi;
  /**
   * Improvement signals from runs and the audit log, computed daily: every
   * one for admins, an App's for its builders.
   */
  readonly signals: SignalsApi;
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
