import { providerFetch } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

// Google's APIs, as this connector's tools reach them: plain `fetch` to
// gmail.googleapis.com (Gmail) and www.googleapis.com (Calendar, Drive),
// through connect's egress, which adds the token and lets through only the
// called tool's routes (threat model R9, Q11).
//
// Addressing. Gmail and Calendar name their resource in the path, by
// address: `/gmail/v1/users/{mailbox}/...`, `/calendar/v3/calendars/
// {calendar}/...`, never Google's aliases `me` and `primary`, so the
// egress binds every request to the mailbox or calendar a call's
// capability names. Drive has no path of its own per drive: it takes a
// shared drive in the query (`corpora=drive&driveId=...`), where the
// egress binds it, and addresses a file by its ID alone, where nothing
// can bind it (see drive.ts).
//
// Batch endpoints are never declared, and the egress strips method
// override headers, which Google honours on a POST. None of the endpoints
// used echoes request headers into its answer (the token would reach this
// code if one did).

export const gmailHost = "gmail.googleapis.com";
export const apisHost = "www.googleapis.com";

/**
 * An ID Google gives a message, a thread, an event, a file or a label:
 * letters, digits, `_` and `-`.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\w-]+$/u);

/** How many results a page holds, at most `max`. */
export const topSchema = (max: number) =>
  z.number().int().min(1).max(max).optional();

/**
 * Where to go on: a previous result's `nextPage` (Google's page token),
 * with the same input. It is sent as `pageToken` on the tool's own route,
 * and only there.
 */
export const pageSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[!-~]+$/u)
  .optional();

type Query = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * A Google URL: the path as given, with the query's set values (a list
 * sends the parameter once for each), and a page token if one is given.
 */
export const googleUrl = (
  host: string,
  path: string,
  query: Query = {},
  page?: string
): URL => {
  const url = new URL(`https://${host}${path}`);
  for (const [name, value] of Object.entries(query)) {
    for (const each of typeof value === "string" ? [value] : (value ?? [])) {
      url.searchParams.append(name, each);
    }
  }
  if (page !== undefined) {
    url.searchParams.set("pageToken", page);
  }
  return url;
};

const googleErrorSchema = z.object({
  error: z.object({
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/**
 * The reasons Google gives a 403 that is a rate limit (Calendar and Drive
 * answer 403 as often as 429): the request was refused before anything
 * was done.
 */
const rateLimitReasons: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

/**
 * Google, through connect's egress. Its reason for an error (`notFound`,
 * `rateLimitExceeded`), or else its status (`NOT_FOUND`), is passed on,
 * never its message.
 */
const google = providerFetch({
  name: "Google",
  errorCodeOf: (body) => {
    const error = googleErrorSchema.safeParse(body).data?.error;
    return error?.errors?.[0]?.reason ?? error?.status;
  },
  isThrottled: (status, code) =>
    status === 403 && code !== undefined && rateLimitReasons.has(code),
  invalidStatuses: [400, 409, 412, 413],
});

/** Sends one request to Google: its answer if it succeeded, else a ToolError. */
export const googleFetch = google.fetch;

/** Google's JSON answer, checked against what the tool expects of it. */
export const googleJson = google.json;

/** The `nextPage` a result hands back: Google's page token, or `null`. */
export const nextPageOf = (token: string | undefined): string | null =>
  token === undefined || token === "" ? null : token;
