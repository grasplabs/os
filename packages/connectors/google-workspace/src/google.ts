import { ToolError } from "@grasp-os/connector-kit/connector";
import { retryAfterOf } from "@grasp-os/connector-kit/content";
import { egressHeader } from "@grasp-os/connector-kit/manifest";
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
 * Text as one path segment: nothing the egress refuses in a parameter
 * (path and query delimiters, `%`, `;`, `:`, controls), so a bad value is
 * refused here, with a clear message, before anything goes out.
 */
// oxlint-disable-next-line no-control-regex -- control characters are refused
export const segmentPattern = /^[^/\\?#%;:\u0000-\u001F\u007F]+$/u;

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

/** One segment of a path, encoded. */
export const segment = (value: string): string => encodeURIComponent(value);

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

/** Google's error reasons and statuses are identifiers. */
const googleErrorCode = /^[A-Za-z][\w.]{0,63}$/u;

const googleErrorSchema = z.object({
  error: z.object({
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/**
 * Google's reason for an error (`notFound`, `rateLimitExceeded`), or its
 * status (`NOT_FOUND`), if its answer names one; never its message.
 */
const errorCodeOf = async (response: Response): Promise<string | undefined> => {
  try {
    const { error } = googleErrorSchema.parse(await response.json());
    const code = error.errors?.[0]?.reason ?? error.status;
    return code !== undefined && googleErrorCode.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The reasons Google gives a 403 that is a rate limit (Calendar and Drive
 * answer 403 as often as 429): the request was refused before anything
 * was done.
 */
const rateLimitReasons: ReadonlySet<string> = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

/** The error connect's egress's own answer stands for. */
const egressFailure = (kind: string): ToolError =>
  kind === "refused"
    ? new ToolError("Connect's egress refused the request", {
        code: "egress_refused",
      })
    : new ToolError("Connect's egress withheld Google's answer", {
        code: "egress_failed",
      });

/**
 * The error a Google answer that isn't a success stands for, with a code
 * callers can act on. Google's messages aren't passed on, since they can
 * repeat what was sent; its reason is.
 *
 * Throttling (429, or a 403 whose reason is a rate limit) means Google did
 * nothing, and a 503 to a read changes nothing either: both say the call
 * did nothing (`notPerformed`), so a write's idempotency key is free again
 * and the caller may try again. That holds for the whole call because
 * every tool sends at most one write, as its last request: nothing of the
 * call went through before it. A 503 to a write may come after Google
 * acted, so it isn't marked.
 */
const failureOf = async (
  response: Response,
  method: string
): Promise<ToolError> => {
  // Connect's egress, not Google, answered: a request the connector's
  // routes don't allow (a bug of ours), or a withheld answer.
  const egress = response.headers.get(egressHeader);
  if (egress !== null) {
    await response.body?.cancel();
    return egressFailure(egress);
  }
  const retryAfterSeconds = retryAfterOf(response);
  const googleCode = await errorCodeOf(response);
  const named = googleCode === undefined ? "" : ` (${googleCode})`;
  const throttled =
    response.status === 429 ||
    (response.status === 403 &&
      googleCode !== undefined &&
      rateLimitReasons.has(googleCode));
  if (throttled) {
    return new ToolError(
      "Google is rate limiting requests: nothing was done. Try again later.",
      {
        code: "throttled",
        retryAfterSeconds: retryAfterSeconds ?? 60,
        notPerformed: true,
      }
    );
  }
  switch (response.status) {
    case 503: {
      return new ToolError("Google is unavailable. Try again later.", {
        code: "unavailable",
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        notPerformed: method === "GET",
      });
    }
    case 401:
    case 403: {
      return new ToolError(`Google refused access${named}`, {
        code: "access_denied",
      });
    }
    case 404: {
      return new ToolError(`Google has no such item${named}`, {
        code: "not_found",
      });
    }
    case 400:
    case 409:
    case 412:
    case 413: {
      return new ToolError(`Google refused the request${named}`, {
        code: "invalid_request",
      });
    }
    default: {
      return new ToolError(`Google answered ${response.status}${named}`, {
        code: "failed",
      });
    }
  }
};

/** Sends one request to Google: its answer if it succeeded, else a ToolError. */
export const googleFetch = async (
  url: URL,
  init: RequestInit = {}
): Promise<Response> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw await failureOf(response, init.method ?? "GET");
  }
  return response;
};

/** Google's JSON answer, checked against what the tool expects of it. */
export const googleJson = async <Schema extends z.ZodType>(
  url: URL,
  schema: Schema,
  init: RequestInit = {}
): Promise<z.output<Schema>> => {
  const response = await googleFetch(url, init);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Google's answer isn't what the connector expects");
  }
  return parsed.data;
};

/** Sends JSON to Google. */
export const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The `nextPage` a result hands back: Google's page token, or `null`. */
export const nextPageOf = (token: string | undefined): string | null =>
  token === undefined || token === "" ? null : token;
