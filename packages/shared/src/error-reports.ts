import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Errors the frontend hit that core never saw (a component that threw, a
// promise nobody caught), which the page reports to core (core's
// error-reports.ts) so they reach the logs beside core's own. A report
// holds what finds the fault, never who hit it or what they were looking
// at: the error's message and stack, the route's pattern (not its URL,
// whose path and query name records), and the build the page runs.

/** Where the page reports an error: one POST each. */
export const errorReportPath = "/api/error-reports";

/** Largest report body core reads, in bytes. */
export const errorReportMaxBytes = 8 * 1024;

/**
 * Longest each field may be, in characters: the page cuts them to this,
 * which keeps a report well under `errorReportMaxBytes`.
 */
export const errorReportLimits = {
  message: 1000,
  stack: 4000,
  route: 200,
  build: 64,
} as const;

/** How the page came to see the error. */
export const errorReportKinds = [
  // A component threw while rendering, and an error boundary caught it.
  "render",
  // Thrown and never caught (`window` `error`).
  "uncaught",
  // A promise rejected with nobody to handle it (`unhandledrejection`).
  "unhandled_rejection",
] as const;

export const errorReportSchema = z.strictObject({
  kind: z.enum(errorReportKinds),
  message: z.string().max(errorReportLimits.message),
  stack: z.string().max(errorReportLimits.stack).optional(),
  /** The route's pattern, such as `/apps/$app`. */
  route: z.string().max(errorReportLimits.route),
  /** The build of the page, which may be older than core's. */
  build: z.string().max(errorReportLimits.build),
});
export type ErrorReport = z.infer<typeof errorReportSchema>;

/** Why core didn't take a report. */
export const errorReportErrors = defineErrorFamily({
  "error_report.invalid": "That isn't an error report.",
  "error_report.too_large": "That error report is too large.",
});
