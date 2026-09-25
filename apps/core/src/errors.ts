import type { CodedError, ErrorPayload } from "@grasp-os/shared/errors";

/**
 * An error response: the error as an `ErrorPayload`, with the request ID in
 * its details so a person can quote it and we can find the logs.
 */
export const errorResponse = (
  status: number,
  error: CodedError,
  requestId: string
): Response => {
  const payload: ErrorPayload = {
    code: error.code,
    message: error.message,
    details: { ...error.details, requestId },
  };
  return Response.json(payload, { status });
};
