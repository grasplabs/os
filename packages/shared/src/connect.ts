import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { connectionIdSchema, identifierSchema } from "./ids.ts";
import { permissionActionSchema } from "./permissions.ts";

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

/** What core reaches in connect, over the `CONNECT` service binding. */
export interface ConnectApi {
  call: (call: ConnectCall) => Promise<ConnectResult>;
}

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
