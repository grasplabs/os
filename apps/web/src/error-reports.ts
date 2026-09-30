import {
  errorReportLimits,
  errorReportMaxBytes,
  errorReportPath,
} from "@grasp-os/shared/error-reports";
import type { ErrorReport } from "@grasp-os/shared/error-reports";
import { messageOf } from "@grasp-os/shared/errors";
import { requestIdHeader } from "@grasp-os/shared/http";

import { CoreTimeoutError } from "./core.ts";

/** The build this page runs, set when it was built. */
const build = import.meta.env.VITE_GRASP_BUILD.slice(
  0,
  errorReportLimits.build
);

/**
 * Whether `error` is a fault of the page's own, worth core's logs: not an
 * answer core gave (any error with a code, where an unplanned one is in
 * core's logs already under its request ID), and not core being out of
 * reach, which the page says to the person and isn't a fault.
 */
export const isPageFault = (error: unknown): boolean => {
  const coded =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string";
  return !(coded || error instanceof CoreTimeoutError);
};

/**
 * Errors reported since the page loaded, by message and stack, with the
 * request ID core gave each report.
 */
const reported = new Map<string, Promise<string | undefined>>();

/** Where the page is: its route's pattern, never the URL itself. */
let routeNow = (): string => "unknown";

/** How many bytes `report` is as the body core reads. */
const bytesOf = (report: ErrorReport): number =>
  new TextEncoder().encode(JSON.stringify(report)).byteLength;

/**
 * `text`'s code points: cut between them, no half of a pair is left, which
 * JSON would escape into more bytes than it was. A joined emoji may come
 * apart, which a report can live with.
 */
// oxlint-disable-next-line typescript/no-misused-spread -- see above
const pointsOf = (text: string): string[] => [...text];

/** `text` without its last `count` code points. */
const withoutLast = (text: string, count: number): string => {
  const points = pointsOf(text);
  return points.slice(0, Math.max(0, points.length - count)).join("");
};

/**
 * `report`, cut to fit in the body core takes: its fields' limits count
 * characters, and a character can take several bytes (or an escape) in
 * JSON. The stack goes first, then the message. A cut drops as many
 * characters as the body is bytes over, and every character is a byte at
 * least, so it fits after the cut.
 */
const fitted = (report: ErrorReport): ErrorReport => {
  const over = bytesOf(report) - errorReportMaxBytes;
  if (over <= 0) {
    return report;
  }
  const { stack, ...withoutStack } = report;
  if (stack !== undefined && pointsOf(stack).length > over) {
    return { ...report, stack: withoutLast(stack, over) };
  }
  const still = bytesOf(withoutStack) - errorReportMaxBytes;
  return still <= 0
    ? withoutStack
    : { ...withoutStack, message: withoutLast(report.message, still) };
};

/**
 * Sends `report` to core: the request ID core logged it under, or
 * undefined for a report it didn't take or that never got there.
 */
const send = async (report: ErrorReport): Promise<string | undefined> => {
  try {
    // `keepalive`: a report of an error that ends the page still goes.
    const response = await fetch(errorReportPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fitted(report)),
      keepalive: true,
    });
    return response.ok
      ? (response.headers.get(requestIdHeader) ?? undefined)
      : undefined;
  } catch {
    // Nothing to do: the page goes on as it was.
    return undefined;
  }
};

/**
 * Reports `error` to core, once per page load for the same message and
 * stack (while a report of it is on its way, or once core took one), and
 * only if it is the page's own fault (`isPageFault`): resolves
 * to the request ID core logged it under, for the person to quote, the
 * same one for each time it is reported again. Never rejects: reporting
 * must not change what the page does.
 */
export const reportError = async (
  kind: ErrorReport["kind"],
  error: unknown
): Promise<string | undefined> => {
  try {
    if (!isPageFault(error)) {
      return undefined;
    }
    const message = messageOf(error).slice(0, errorReportLimits.message);
    const stack =
      error instanceof Error
        ? error.stack?.slice(0, errorReportLimits.stack)
        : undefined;
    const seen = `${message}\n${stack ?? ""}`;
    const earlier = reported.get(seen);
    if (earlier !== undefined) {
      return await earlier;
    }
    const sent = send({
      kind,
      message,
      ...(stack === undefined ? {} : { stack }),
      route: routeNow().slice(0, errorReportLimits.route),
      build,
    });
    reported.set(seen, sent);
    const requestId = await sent;
    if (requestId === undefined) {
      // Not taken (core out of reach, or past its limit): the next time
      // the error comes, it is reported again.
      reported.delete(seen);
    }
    return requestId;
  } catch {
    // Something thrown that can't even be read as text: let it go.
    return undefined;
  }
};

/**
 * Reports what the page throws and never catches, and promises that
 * reject with nobody to handle them. `route` says which route's pattern
 * the page is on when one comes.
 */
export const reportUncaughtErrors = (route: () => string | undefined): void => {
  routeNow = () => route() ?? "unknown";
  window.addEventListener("error", (event) => {
    // A resource that failed to load has no error: not a fault of code.
    if (event.error !== undefined && event.error !== null) {
      void reportError("uncaught", event.error);
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    void reportError("unhandled_rejection", event.reason);
  });
};
