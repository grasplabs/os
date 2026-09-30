import {
  errorReportLimits,
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
      body: JSON.stringify(report),
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
 * stack, and only if it is the page's own fault (`isPageFault`): resolves
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
    return await sent;
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
