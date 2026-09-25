import type { Role } from "./index.ts";
import type {
  Permission,
  PermissionRequest,
  PermissionSubjectInput,
} from "./permissions.ts";

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
 * closes.
 */
export interface SessionApi {
  /** The person behind the session, with their current role and teams. */
  whoami: () => Promise<Identity>;
  /**
   * Asks for a permission for an App or agent (a `PermissionRequest`);
   * it allows nothing until an admin grants it. Admins and builders.
   */
  requestPermission: (request: PermissionRequest) => Promise<Permission>;
  /** Grants a requested permission. Admins only. */
  grantPermission: (id: string) => Promise<Permission>;
  /** Revokes a permission; the next call that needs it is refused. Admins only. */
  revokePermission: (id: string) => Promise<Permission>;
  /** Every permission, or one App's or agent's. Admins and builders. */
  listPermissions: (subject?: PermissionSubjectInput) => Promise<Permission[]>;
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
