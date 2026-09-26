import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { connectionIdSchema, identifierSchema } from "./ids.ts";
import { permissionActionSchema } from "./permissions.ts";
import { roleSchema } from "./roles.ts";

/**
 * One call from core to connect, over the service binding: an action on a
 * connection, with the capability core made for exactly this call.
 */
export const connectCallSchema = z.strictObject({
  /** Checked on its own, so a call without one is refused for that. */
  capability: z.unknown().optional(),
  connectionId: connectionIdSchema,
  resource: identifierSchema.optional(),
  action: permissionActionSchema,
  input: z.json(),
  /** Required for side effects: a repeat returns the stored result. */
  idempotencyKey: identifierSchema.optional(),
});
export type ConnectCall = z.infer<typeof connectCallSchema>;

/** What an action returns. */
export interface ConnectResult {
  /**
   * The action's output, as JSON text: a type for any JSON value is too deep
   * for the RPC types to follow.
   */
  output: string;
  /**
   * The IDs of the resources the action read (messages, files, events), as
   * its connector names them, so callers can label what they build from the
   * output. Empty when the connector names none.
   */
  provenance: string[];
}

// Connecting accounts. A person starts and finishes the OAuth flow in their
// own browser, signed in to core; core says who they are, and connect keeps
// everything else: the flow's state and PKCE verifier, and the tokens, which
// never leave it (threat model R1).

/** The outside systems a person connects through OAuth. */
export const oauthProviderSchema = z.enum(["microsoft", "google"]);
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/**
 * Personal: the person's own account, used only for them. Shared: an
 * account the organization uses (a service mailbox, say), connected by an
 * admin; permissions decide who uses it.
 */
export const connectionScopeSchema = z.enum(["personal", "shared"]);
export type ConnectionScope = z.infer<typeof connectionScopeSchema>;

/** Where the provider sends the browser back to, on the client's origin. */
export const connectionCallbackPath = "/api/connections/callback";

/** Longest path a flow may send the browser back to. */
export const returnPathMaxLength = 512;

/** The signed-in person a request comes from, as core read them just now. */
export const connectionPersonSchema = z.strictObject({
  userId: identifierSchema,
  role: roleSchema,
  /** Grasp staff, in a staff window. */
  staff: z.boolean(),
  /** The email they signed in with, verified by their IdP. */
  email: identifierSchema,
  /**
   * The IdP accounts they sign in with, by their subject at that provider
   * (the Entra object ID, the Google subject): a personal connection must
   * be to one of these, where they have one at that provider.
   */
  accounts: z
    .array(
      z.strictObject({
        provider: oauthProviderSchema,
        subject: identifierSchema,
      })
    )
    .max(8),
});
export type ConnectionPerson = z.infer<typeof connectionPersonSchema>;

/** Starts connecting an account. */
export const startConnectionSchema = z.strictObject({
  person: connectionPersonSchema,
  provider: oauthProviderSchema,
  scope: connectionScopeSchema,
  /** The deployment's origin, from its config: the provider returns there. */
  origin: z.url(),
  /**
   * The organization at the provider, from the deployment's sign-in config:
   * its Entra tenant ID, or its Google Workspace domain. Only accounts in
   * it can be connected.
   */
  tenant: identifierSchema,
  /** A path on the deployment's origin; core checks it. */
  returnTo: z.string().startsWith("/").max(returnPathMaxLength),
});
export type StartConnection = z.input<typeof startConnectionSchema>;

/** The provider's answer, as the browser brought it back to core. */
export const finishConnectionSchema = z.strictObject({
  person: connectionPersonSchema,
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(4096).optional(),
  /** The provider's error code, when it sent one instead of a code. */
  error: z.string().min(1).max(256).optional(),
});
export type FinishConnection = z.input<typeof finishConnectionSchema>;

export const disconnectSchema = z.strictObject({
  person: connectionPersonSchema,
  connectionId: connectionIdSchema,
});
export type Disconnect = z.input<typeof disconnectSchema>;

/** One connection, as people see it: never its tokens. */
export interface ConnectionSummary {
  id: string;
  provider: string;
  scope: ConnectionScope;
  status: "active" | "needs_reauth" | "disconnected";
  /** A personal connection's owner; `null` for a shared one. */
  ownerUserId: string | null;
  /** Who connected it. */
  connectedBy: string | null;
  /** The account at the provider, such as its email address. */
  accountName: string | null;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * A signed-in person's connections, over `/rpc`. Starting one returns the
 * provider URL to send the browser to; the provider sends it back to
 * core's callback, which returns it to `returnTo` (a path on this origin)
 * with `connection=<id>`, or `connectionError=<code>`.
 */
export interface ConnectionsApi {
  start: (request: {
    provider: OAuthProvider;
    scope: ConnectionScope;
    returnTo?: string;
  }) => Promise<{ url: string }>;
  list: () => Promise<ConnectionSummary[]>;
  disconnect: (connectionId: string) => Promise<{ revoked: boolean }>;
}

/** What core reaches in connect, over the `CONNECT` service binding. */
export interface ConnectApi {
  call: (call: ConnectCall) => Promise<ConnectResult>;
  /** The provider URL to send the person's browser to. */
  startConnection: (request: StartConnection) => Promise<{ url: string }>;
  /** Finishes a flow the same person started: the new connection. */
  finishConnection: (
    request: FinishConnection
  ) => Promise<{ connectionId: string; returnTo: string }>;
  /** The person's own connections and the shared ones. */
  listConnections: (person: ConnectionPerson) => Promise<ConnectionSummary[]>;
  /**
   * Deletes the connection's tokens, revoking them at the provider where it
   * can (`revoked`); the connection takes no more calls.
   */
  disconnect: (request: Disconnect) => Promise<{ revoked: boolean }>;
  /**
   * Spends a flow that came back but can't finish (no session, say), so its
   * code can't be brought back to finish it later.
   */
  abandonFlow: (state: string) => Promise<void>;
}

/** Why connecting or disconnecting an account didn't work. */
export const connectionErrors = defineErrorFamily({
  "connection.invalid_request": "That isn't a valid connection request.",
  "connection.provider_unavailable":
    "Connecting this provider isn't set up for this deployment.",
  "connection.flow_invalid":
    "This connection attempt has expired, was already used, or was started by someone else. Start again.",
  "connection.provider_refused":
    "The provider didn't complete the connection. Start again.",
  "connection.wrong_account":
    "That account isn't in your organization. Connect an account of your organization.",
  "connection.refresh_failed":
    "The provider didn't renew this connection's access. Try again shortly.",
  "connection.already_connected":
    "That account is already connected here. Disconnect it first to connect it again.",
  "connection.not_own_account":
    "A personal connection must be to your own account, the one you sign in with.",
  "connection.staff_not_allowed":
    "Grasp staff can't connect accounts in a client's deployment.",
});

/** Why connect refused or couldn't finish a call, other than its capability. */
export const connectErrors = defineErrorFamily({
  "connect.invalid_call":
    "That isn't a valid call: an action name, JSON input and options.",
  "connect.connection_not_found": "There's no such connection.",
  "connect.connection_inactive":
    "This connection isn't active: it needs to be connected again.",
  "connect.not_owner":
    "This is someone's personal connection: only calls for its owner can use it.",
  "connect.action_not_found": "This connection has no such action.",
  "connect.input_too_large": "This call's input is too large.",
  "connect.confirmation_required":
    "This action has a side effect, and changes from chat need the person to confirm them first.",
  "connect.resource_out_of_scope":
    "This call reaches beyond the one resource it may use.",
  "connect.idempotency_key_required":
    "This action has a side effect, so it needs an idempotency key.",
  "connect.idempotency_conflict":
    "This idempotency key was already used with a different input.",
  "connect.answer_not_kept":
    "A call with this idempotency key already ran, but its answer is no longer kept, so it won't run again. Use a new key to run it anew.",
  "connect.call_in_progress":
    "A call with this idempotency key is still running. Try again shortly.",
  "connect.outcome_unknown":
    "A call with this idempotency key was interrupted after it was sent, so it may or may not have taken effect. Check before trying again with a new key.",
  "connect.action_failed": "The action reported an error.",
  "connect.server_unavailable":
    "The connection's server didn't take the call, so nothing was done.",
});
