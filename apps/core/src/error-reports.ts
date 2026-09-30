import {
  errorReportErrors,
  errorReportMaxBytes,
  errorReportSchema,
} from "@grasp-os/shared/error-reports";
import { authErrors, requestErrors } from "@grasp-os/shared/errors";
import { readAtMost } from "@grasp-os/shared/http";
import { log } from "@grasp-os/shared/log";

import { identify } from "./auth/identity.ts";
import { errorResponse } from "./errors.ts";
import { isOwnOrigin } from "./rpc.ts";

/** Most reports one person makes in a minute; the rest are refused. */
export const errorReportsPerMinute = 10;

/**
 * Reports taken this minute, by person. Kept in memory, as a fixed window:
 * each of core's isolates counts on its own and starts again when it
 * restarts, which bounds a person's reports per isolate, enough to keep a
 * page in a loop from flooding the logs, without a store of its own. The
 * whole map goes when the minute turns, so it never outgrows one minute's
 * reporters.
 */
let counted = { minute: 0, counts: new Map<string, number>() };

/** Counts one report of `userId`'s: false once they are past the limit. */
const withinLimit = (userId: string): boolean => {
  const minute = Math.floor(Date.now() / 60_000);
  if (counted.minute !== minute) {
    counted = { minute, counts: new Map() };
  }
  const count = counted.counts.get(userId) ?? 0;
  if (count >= errorReportsPerMinute) {
    return false;
  }
  counted.counts.set(userId, count + 1);
  return true;
};

/** `text` as JSON, or undefined when it isn't. */
const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * `POST /api/error-reports`: an error the page hit, into core's logs as an
 * `web.error` line beside core's own errors, with this request's ID. Only
 * from the deployment's own pages (`Origin`, and a JSON body, which a form
 * on another site can't send), for someone signed in, at most
 * `errorReportsPerMinute` a minute each, and at most `errorReportMaxBytes`
 * long, counted as it is read. The line leaves out who reported it: the
 * report is about the page, never the person.
 */
export const errorReportResponse = async (
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> => {
  if (request.method !== "POST") {
    return errorResponse(
      404,
      requestErrors.create("request.not_found"),
      requestId
    );
  }
  const json =
    request.headers.get("content-type")?.split(";")[0]?.trim() ===
    "application/json";
  if (!(isOwnOrigin(request, env) && json)) {
    return errorResponse(
      403,
      requestErrors.create("request.forbidden"),
      requestId
    );
  }
  const person = await identify(env, request.headers);
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  if (!withinLimit(person.userId)) {
    const response = errorResponse(
      429,
      requestErrors.create("request.rate_limited"),
      requestId
    );
    response.headers.set("retry-after", "60");
    return response;
  }
  // SAFETY: a request's body in workerd is a byte stream, of Uint8Array
  // chunks; its type says `any` only for streams in general.
  const stream = request.body as ReadableStream<Uint8Array> | null;
  const length = Number(request.headers.get("content-length") ?? 0);
  const body =
    stream === null || length > errorReportMaxBytes
      ? undefined
      : await readAtMost(stream, errorReportMaxBytes);
  if (stream !== null && body === undefined) {
    return errorResponse(
      413,
      errorReportErrors.create("error_report.too_large"),
      requestId
    );
  }
  const report = errorReportSchema.safeParse(
    body === undefined ? undefined : jsonOf(new TextDecoder().decode(body))
  );
  if (!report.success) {
    return errorResponse(
      400,
      errorReportErrors.create("error_report.invalid"),
      requestId
    );
  }
  const { kind, message, stack, route, build } = report.data;
  log.error("web.error", {
    requestId,
    kind,
    route,
    build,
    errorMessage: message,
    errorStack: stack,
  });
  return new Response(null, { status: 204 });
};
