import { z } from "zod";

/**
 * An error as data, for when it crosses a boundary (an RPC call or an HTTP
 * response body). Plain JSON, so it survives serialisation and reads the same
 * on both sides.
 */
export const errorPayloadSchema = z.object({
  /** Stable and machine-readable, e.g. `permission.denied`; branch on this. */
  code: z.string().min(1),
  /** For people; may change between releases, so never branch on it. */
  message: z.string(),
  /** Structured context, e.g. which input failed validation. */
  details: z.record(z.string(), z.json()).optional(),
});
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

/**
 * An `Error` with a stable code. `code` and `details` are own properties, so
 * Cap'n Web carries them across the wire along with the message.
 */
export type CodedError<Code extends string = string> = Error & {
  code: Code;
  details?: ErrorPayload["details"];
};

/**
 * Defines one family of expected errors: a fixed set of codes, each with the
 * message people see. Create errors from it, and read the code back from
 * anything caught, including errors that crossed an RPC boundary.
 */
export const defineErrorFamily = <Code extends string>(
  messages: Readonly<Record<Code, string>>
) => {
  const codes = new Set<unknown>(Object.keys(messages));
  const isCode = (value: unknown): value is Code => codes.has(value);

  return {
    create: (code: Code, details?: ErrorPayload["details"]): CodedError<Code> =>
      Object.assign(
        new Error(messages[code]),
        details === undefined ? { code } : { code, details }
      ),
    /** The error's code if it belongs to this family, otherwise `undefined`. */
    codeOf: (error: unknown): Code | undefined => {
      if (typeof error !== "object" || error === null || !("code" in error)) {
        return undefined;
      }
      return isCode(error.code) ? error.code : undefined;
    },
  };
};

/** Why core refused a request before it reached any feature. */
export const requestErrors = defineErrorFamily({
  "request.forbidden": "Forbidden.",
  "request.not_found": "Not found.",
  "request.upgrade_required":
    "This endpoint only accepts WebSocket connections.",
});

/**
 * Anything nobody planned for. Its details carry the request ID, never the
 * cause: that stays in the logs.
 */
export const internalErrors = defineErrorFamily({
  "internal.unexpected": "Something went wrong.",
});
