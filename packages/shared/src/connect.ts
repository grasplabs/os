import { z } from "zod";

import { auditIdentifierMaxLength } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";
import { connectionIdSchema } from "./ids.ts";
import { permissionActionSchema } from "./permissions.ts";

const identifier = () => z.string().min(1).max(auditIdentifierMaxLength);

/**
 * One call from core to connect, over the service binding: an action on a
 * connection, with the capability core made for exactly this call.
 */
export const connectCallSchema = z.strictObject({
  /** Checked on its own, so a call without one is refused for that. */
  capability: z.unknown().optional(),
  connectionId: identifier().pipe(connectionIdSchema),
  resource: identifier().optional(),
  action: permissionActionSchema,
  input: z.json(),
  /** Required for side effects: a repeat returns the stored result. */
  idempotencyKey: identifier().optional(),
});
export type ConnectCall = z.infer<typeof connectCallSchema>;

/** What an action returns. */
export interface ConnectResult {
  /**
   * The action's output, as JSON text: a type for any JSON value is too deep
   * for the RPC types to follow.
   */
  output: string;
}

/** What core reaches in connect, over the `CONNECT` service binding. */
export interface ConnectApi {
  call: (call: ConnectCall) => Promise<ConnectResult>;
}

/** Why connect refused a call, other than its capability. */
export const connectErrors = defineErrorFamily({
  "connect.invalid_call":
    "That isn't a valid call: an action name, JSON input and options.",
  "connect.connection_not_found": "There's no such connection.",
});
