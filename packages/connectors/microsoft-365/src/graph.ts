import { invalidCode, ToolError } from "@grasp-os/connector-kit/connector";
import { retryAfterOf } from "@grasp-os/connector-kit/content";
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import { z } from "zod";

// Microsoft Graph, as this connector's tools reach it: plain `fetch` to
// graph.microsoft.com, through connect's egress, which adds the token and
// lets through only the called tool's routes (threat model R9, Q11).
//
// Addressing. Every route names its resources by ID, one path segment
// each: `/users/{mailbox}/messages/{message}`, `/drives/{drive}/items/{item}`.
// Graph's path addressing (`/root:/folder/file.pdf:`) isn't used: a path
// value would carry `/` and `:`, which the egress refuses in a parameter,
// and one template couldn't bind it. Mail and calendars go through
// `/users/{mailbox}` only, never `/me`, so the egress binds every request
// to the mailbox a call's capability names: a call for one mailbox can't
// reach another. Files go through `/drives/{drive}`, a OneDrive or a
// SharePoint document library alike, bound the same way.
//
// None of the endpoints used echoes request headers into its answer (the
// token would reach this code if one did): Graph's answers carry its own
// `request-id` and `client-request-id`, which this code doesn't send.

export const graphHost = "graph.microsoft.com";

/**
 * Where a download may be redirected to: Graph answers a file's `/content`
 * with a redirect to a pre-authenticated URL on the tenant's SharePoint
 * (`<tenant>.sharepoint.com`, `<tenant>-my.sharepoint.com` for OneDrive),
 * which connect's egress follows without the token.
 */
export const downloadHosts = ["*.sharepoint.com"];

/** Graph's v1.0 API. */
export const v1 = "/v1.0";

/**
 * Text as one path segment: nothing the egress refuses in a parameter
 * (path and query delimiters, `%`, `;`, `:`, controls), so a bad value is
 * refused here, with a clear message, before anything goes out.
 */
// oxlint-disable-next-line no-control-regex -- control characters are refused
export const segmentPattern = /^[^/\\?#%;:\u0000-\u001F\u007F]+$/u;

/**
 * A Graph ID (a message's, an event's, an item's, an attachment's) or a
 * well-known folder name (`inbox`), in Graph's alphabet: letters, digits
 * and `-_=!.`.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[\w=!.-]+$/u);

/** A mailbox: its address (`invoices@example.com`) or its user ID. */
export const mailboxSchema = z.string().min(1).max(256).regex(segmentPattern);

/** A drive: a OneDrive's or a SharePoint document library's ID, `b!...`. */
export const driveSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^b![\w=!.-]+$/u);

/** How many results a page holds. */
export const topSchema = z.number().int().min(1).max(50).optional();

/** Where to go on: a previous result's `nextPage`, with the same input. */
export const pageSchema = z.string().min(1).max(4096).optional();

/** One segment of a path, encoded. */
export const segment = (value: string): string => encodeURIComponent(value);

/** A Graph URL: the path as given, with the query's set values. */
export const graphUrl = (
  path: string,
  query: Readonly<Record<string, string | undefined>> = {}
): URL => {
  const url = new URL(`https://${graphHost}${v1}${path}`);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(name, value);
    }
  }
  return url;
};

/** Graph's error codes are identifiers, such as `ErrorItemNotFound`. */
const graphErrorCode = /^[A-Za-z][\w.]{0,63}$/u;

const graphErrorSchema = z.object({
  error: z.object({ code: z.string() }),
});

/** Graph's error code, if its answer names one; never its message. */
const errorCodeOf = async (response: Response): Promise<string | undefined> => {
  try {
    const parsed = graphErrorSchema.safeParse(await response.json());
    const code = parsed.data?.error.code;
    return code !== undefined && graphErrorCode.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The error a Graph answer that isn't a success stands for, with a code
 * callers can act on. Graph's messages aren't passed on, since they can
 * repeat what was sent; its error code is.
 *
 * Throttling (429) means Graph did nothing, and a 503 to a read changes
 * nothing either: both say the call did nothing (`notPerformed`), so a
 * write's idempotency key is free again and the caller may try again.
 * That holds for the whole call because every tool sends at most one
 * write, as its last request (mail.move's folder lookup before it is a
 * read): nothing of the call went through before it. A 503 to a write may
 * come after Graph acted, so it isn't marked.
 */
const failureOf = async (
  response: Response,
  method: string
): Promise<ToolError> => {
  // Connect's egress, not Graph, answered: a request the connector's
  // routes don't allow (a bug of ours), or a withheld answer.
  const egress = response.headers.get(egressHeader);
  if (egress !== null) {
    await response.body?.cancel();
    switch (egress) {
      case "refused": {
        return new ToolError("Connect's egress refused the request", {
          code: "egress_refused",
        });
      }
      case "downloads-off": {
        return new ToolError(
          "Downloads aren't set up for this deployment: its SharePoint hosts (DOWNLOAD_HOSTS) aren't configured",
          { code: "downloads_unavailable" }
        );
      }
      default: {
        return new ToolError(
          "Connect's egress withheld Microsoft 365's answer",
          {
            code: "egress_failed",
          }
        );
      }
    }
  }
  const retryAfterSeconds = retryAfterOf(response);
  const graphCode = await errorCodeOf(response);
  const named = graphCode === undefined ? "" : ` (${graphCode})`;
  switch (response.status) {
    case 429: {
      return new ToolError(
        "Microsoft 365 is throttling requests: nothing was done. Try again later.",
        {
          code: "throttled",
          retryAfterSeconds: retryAfterSeconds ?? 60,
          notPerformed: true,
        }
      );
    }
    case 503: {
      return new ToolError("Microsoft 365 is unavailable. Try again later.", {
        code: "unavailable",
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        notPerformed: method === "GET",
      });
    }
    case 401:
    case 403: {
      return new ToolError(`Microsoft 365 refused access${named}`, {
        code: "access_denied",
      });
    }
    case 404: {
      return new ToolError(`Microsoft 365 has no such item${named}`, {
        code: "not_found",
      });
    }
    case 400:
    case 409:
    case 413:
    case 422: {
      return new ToolError(`Microsoft 365 refused the request${named}`, {
        code: invalidCode,
      });
    }
    default: {
      return new ToolError(
        `Microsoft 365 answered ${response.status}${named}`,
        { code: "failed" }
      );
    }
  }
};

/** Sends one request to Graph: its answer if it succeeded, else a ToolError. */
export const graphFetch = async (
  url: URL,
  init: RequestInit = {}
): Promise<Response> => {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw await failureOf(response, init.method ?? "GET");
  }
  return response;
};

/** Graph's JSON answer, checked against what the tool expects of it. */
export const graphJson = async <Schema extends z.ZodType>(
  url: URL,
  schema: Schema,
  init: RequestInit = {}
): Promise<z.output<Schema>> => {
  const response = await graphFetch(url, init);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Microsoft 365's answer isn't what the connector expects");
  }
  return parsed.data;
};

/** Sends JSON to Graph. */
export const jsonBody = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** A page of a Graph collection. */
export const pageOf = <Item extends z.ZodType>(item: Item) =>
  z.object({
    value: z.array(item),
    "@odata.nextLink": z.string().optional(),
  });

/**
 * The query parameters that carry Graph's position in a collection. A
 * next page is asked for on the tool's own route, with the tool's own
 * query and only these taken from Graph's `@odata.nextLink`: the link is
 * never followed as a URL.
 */
const pagingParameters = ["$skip", "$skiptoken"];

/**
 * The `nextPage` a result hands back for Graph's `@odata.nextLink`, or
 * `null` at the end: only its position (`$skip`, `$skiptoken`).
 */
export const nextPageOf = (nextLink: string | undefined): string | null => {
  if (nextLink === undefined) {
    return null;
  }
  let link: URL;
  try {
    link = new URL(nextLink);
  } catch {
    throw new Error("Microsoft 365's next page link isn't a URL");
  }
  const position = new URLSearchParams();
  for (const name of pagingParameters) {
    const value = link.searchParams.get(name);
    if (value !== null) {
      position.set(name, value);
    }
  }
  if (link.hostname !== graphHost || position.size === 0) {
    throw new Error("Microsoft 365's next page link has no position");
  }
  return position.toString();
};

/** `url` at the position `page` names (from `nextPageOf`), if any. */
export const atPage = (url: URL, page: string | undefined): URL => {
  if (page === undefined) {
    return url;
  }
  const position = new URLSearchParams(page);
  let found = false;
  for (const name of pagingParameters) {
    const value = position.get(name);
    if (value !== null) {
      url.searchParams.set(name, value);
      found = true;
    }
  }
  if (!found) {
    throw new ToolError("That isn't a page this tool handed out", {
      code: invalidCode,
    });
  }
  return url;
};
