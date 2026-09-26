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
 * Every code of every family defined: the expected errors, which whoever
 * made the call may see, a person or App code. A family's module is loaded
 * before any of its errors can be created, so its codes are here by then.
 */
const expectedCodes = new Set<string>();

/**
 * Defines one family of expected errors: a fixed set of codes, each with the
 * message people see. Create errors from it, and read the code back from
 * anything caught, including errors that crossed an RPC boundary.
 */
export const defineErrorFamily = <Code extends string>(
  messages: Readonly<Record<Code, string>>
) => {
  const codes = new Set<unknown>(Object.keys(messages));
  for (const code of Object.keys(messages)) {
    expectedCodes.add(code);
  }
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

/**
 * What's wrong with some input, for an error's `details.issues`: each issue
 * as `path: message`, which names the field and never repeats its value.
 */
export const issuesOf = (error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string[] =>
  error.issues.map(
    ({ path, message }) => `${path.map(String).join(".")}: ${message}`
  );

/** Why core refused a request before it reached any feature. */
export const requestErrors = defineErrorFamily({
  "request.forbidden": "Forbidden.",
  "request.not_found": "Not found.",
  "request.upgrade_required":
    "This endpoint only accepts WebSocket connections.",
});

/** Why a call needs a person to sign in (again). */
export const authErrors = defineErrorFamily({
  "auth.unauthenticated": "Sign in to continue.",
});

/** Why a call was refused: its feature is switched off for this deployment. */
export const featureErrors = defineErrorFamily({
  "feature.disabled": "This isn't switched on for this deployment.",
});

/**
 * Anything nobody planned for. Its details carry the request ID, never the
 * cause: that stays in the logs.
 */
export const internalErrors = defineErrorFamily({
  "internal.unexpected": "Something went wrong.",
});

/** Whether `error` is an expected error, of any family. */
export const isExpectedError = (error: unknown): error is CodedError =>
  error instanceof Error &&
  "code" in error &&
  typeof error.code === "string" &&
  expectedCodes.has(error.code);

/**
 * What a caller outside core may see of `error`: an expected error as it is,
 * anything else replaced by `internal.unexpected` with `details` (such as the
 * request ID) and no stack, so internals never leave.
 */
export const toOpaqueError = (
  error: unknown,
  details?: ErrorPayload["details"]
): Error => {
  if (isExpectedError(error)) {
    return error;
  }
  const replacement = internalErrors.create("internal.unexpected", details);
  // Cap'n Web sends a replacement's stack; this one has none to send.
  replacement.stack = undefined;
  return replacement;
};
