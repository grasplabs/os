import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { connectionIdSchema, identifierSchema } from "./ids.ts";
import { permissionActionSchema } from "./permissions.ts";
import type { PermissionSubject, WorkContext } from "./permissions.ts";
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
  /**
   * Set when connect held the call for the person it acts for to confirm
   * (a side effect from chat, from a person using an App, or from a context
   * that read restricted data): nothing was done yet, so `output` is the
   * JSON text `"null"` and `provenance` is empty. A repeat with the same
   * idempotency key finds the same held action until it is decided, and
   * the action's answer once it ran. A workflow run's call is never
   * answered so: it fails with `connect.held`, and core waits for the
   * person's decision before running the step again.
   */
  pending?: PendingReference;
}

/** A held action, as the call connect held returns it. */
export interface PendingReference {
  id: string;
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

/**
 * How long a person has to finish an OAuth flow at the provider. Core also
 * keeps retrying a removed person's disconnect this long after the
 * removal, for a flow that was already finishing when it ran.
 */
export const oauthFlowLifetimeMs = 10 * 60 * 1000;

/** Most people one `disconnectPersonal` call takes. */
export const disconnectPersonalMaxOwners = 100;

/**
 * Disconnects every personal connection of the people `ownerUserIds`, who
 * were removed from the organization: for the admin `person` who removed
 * them, or, with `person` null, for core itself, which retries for people
 * whose disconnect hasn't completed yet.
 */
export const disconnectPersonalSchema = z.strictObject({
  person: connectionPersonSchema.nullable(),
  ownerUserIds: z.array(identifierSchema).max(disconnectPersonalMaxOwners),
});
export type DisconnectPersonal = z.input<typeof disconnectPersonalSchema>;

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

// Side effects held for their person (threat model R7, R12). Connect
// holds a side effect from chat, from a person using an App, or from any
// context that read restricted data, until the person it acts for confirms
// it on a view of the exact input it will run with; confirming runs that
// input, once; declining drops it. Core names the person from their
// session, as for connecting accounts, and signs the confirmed call's
// capability after checking the permission and the context again.

/** A held action, as the person it waits for sees it. */
export interface PendingAction {
  id: string;
  /** The App or agent that asked for it. */
  subject: PermissionSubject;
  /** For an App's code: the version that asked. */
  appVersion: number | null;
  /** Asked for with the person there, or by a workflow run. */
  mode: "interactive" | "workflow";
  /** The chat, App or run it came from. */
  context: WorkContext;
  /**
   * Asked for by a chat, App or run that had read restricted data, or, as
   * core lists it, from one that has read restricted data by now: what it
   * sends out may carry that data. Show the person a warning; the
   * confirmation and its events record it.
   */
  restricted: boolean;
  /** The permission that allowed it. */
  permissionId: string;
  connectionId: string;
  resource: string | null;
  action: string;
  /** The key its answer is kept under: a repeat of the call gets it. */
  idempotencyKey: string;
  /** The exact input it runs with once confirmed, as JSON text. */
  input: string;
  /**
   * SHA-256 of its resource and input: confirming names it, so only what
   * the person was shown runs.
   */
  inputHash: string;
  /** ISO 8601. */
  requestedAt: string;
}

const inputHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/** Runs a held action its person confirmed, with core's capability for it. */
export const confirmActionSchema = z.strictObject({
  capability: z.unknown(),
  person: connectionPersonSchema,
  id: z.uuid(),
  inputHash: inputHashSchema,
});
export type ConfirmAction = z.input<typeof confirmActionSchema>;

/** Drops a held action its person declined. */
export const declineActionSchema = z.strictObject({
  person: connectionPersonSchema,
  id: z.uuid(),
});
export type DeclineAction = z.input<typeof declineActionSchema>;

/** One held action, for the person it waits for. */
export const heldRequestSchema = z.strictObject({
  person: connectionPersonSchema,
  id: z.uuid(),
});
export type HeldRequest = z.input<typeof heldRequestSchema>;

/** A confirmation core refused, with why, for the audit log. */
export const refuseConfirmationSchema = z.strictObject({
  person: connectionPersonSchema,
  id: z.uuid(),
  /** An error code, such as `permission.denied`: never free text. */
  reason: z
    .string()
    .regex(/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/u)
    .max(64),
});
export type RefuseConfirmation = z.input<typeof refuseConfirmationSchema>;

/** The held side effects of one workflow run's step, by the step's key. */
export const pendingKeySchema = z.strictObject({
  onBehalfOf: identifierSchema,
  idempotencyKey: identifierSchema,
});
export type PendingKey = z.input<typeof pendingKeySchema>;

/**
 * The held actions waiting for a signed-in person, over `/rpc`: only
 * their own. Grasp staff have none, and decide none.
 */
export interface PendingActionsApi {
  list: () => Promise<PendingAction[]>;
  /**
   * Runs the held action `id`, with the input whose hash is `inputHash`,
   * once: its answer, as the call would have had it.
   */
  confirm: (id: string, inputHash: string) => Promise<ConnectResult>;
  /** Drops the held action `id`: it never runs. */
  decline: (id: string) => Promise<void>;
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
   * Disconnects every personal connection of someone an admin removed from
   * the organization, as `disconnect` does each one, and spends the flows
   * they still have open. Admins only, or core itself (`person` null); core
   * calls it only for people it removed. Returns how many it stopped.
   */
  disconnectPersonal: (
    request: DisconnectPersonal
  ) => Promise<{ disconnected: number }>;
  /**
   * Spends a flow that came back but can't finish (no session, say), so its
   * code can't be brought back to finish it later.
   */
  abandonFlow: (state: string) => Promise<void>;
  /**
   * The held actions waiting for `person`, newest first (at most 200):
   * none for Grasp staff.
   */
  listPendingActions: (person: ConnectionPerson) => Promise<PendingAction[]>;
  /** One held action waiting for the person, or `null`. */
  pendingAction: (request: HeldRequest) => Promise<PendingAction | null>;
  /**
   * Drops a workflow run's held action whose run has ended, found when its
   * person came to confirm it.
   */
  dropForEndedRun: (request: HeldRequest) => Promise<void>;
  /**
   * Runs a held action its person confirmed: only with the capability core
   * signed for confirming it, and only for that person.
   */
  confirmAction: (request: ConfirmAction) => Promise<ConnectResult>;
  /** Drops a held action its person declined. */
  declineAction: (request: DeclineAction) => Promise<void>;
  /**
   * Whether any side effect with idempotency key `idempotencyKey`, acting
   * for `onBehalfOf`, still waits for that person: a workflow run waits
   * before running a step whose side effect was held again.
   */
  anyPending: (request: PendingKey) => Promise<boolean>;
  /**
   * Records a confirmation core refused before it reached connect (the
   * permission is gone, the person has left, the context is invalid): the
   * held action keeps waiting.
   */
  refuseConfirmation: (request: RefuseConfirmation) => Promise<void>;
}

/** Why connecting or disconnecting an account didn't work. */
export const connectionErrors = defineErrorFamily({
  "connection.invalid": "That isn't a valid connection request.",
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
  "connect.invalid":
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
  "connect.mask_unsupported":
    "This permission masks fields this connection's server can't mask, so nothing was done.",
  "connect.search_masked":
    "This permission masks fields this search would look through, so the search wasn't run.",
  "connect.idempotency_key_required":
    "This action has a side effect, so it needs an idempotency key.",
  "connect.idempotency_conflict":
    "This idempotency key was already used with a different input.",
  "connect.answer_not_kept":
    "A call with this idempotency key already ran, but its answer is no longer kept, so it won't run again.",
  "connect.call_in_progress":
    "A call with this idempotency key is still running. Try again shortly.",
  "connect.outcome_unknown":
    "A call with this idempotency key was interrupted after it was sent, so it may or may not have taken effect, and it won't be sent again. Check the outside system to see whether it did.",
  "connect.action_failed": "The action reported an error.",
  "connect.pending_not_found":
    "There's no such action waiting for you: it was confirmed or declined, or it isn't yours.",
  "connect.pending_changed":
    "This isn't the action you were shown, so nothing was done. Look at it again.",
  "connect.held":
    "This action waits for the person it acts for to confirm it. Try again once they have.",
  "connect.run_ended":
    "The workflow run this action was held for has ended, so it was dropped and won't run.",
  "connect.declined":
    "The person this action acts for declined it, or it was dropped when its connection or person went, so it won't run.",
  "connect.connection_changed":
    "This connection now reaches another account than when the action was asked for, so it wasn't run.",
  "connect.server_unavailable":
    "The connection's server didn't take the call, so nothing was done.",
});
