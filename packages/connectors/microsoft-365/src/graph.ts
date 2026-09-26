import { invalidCode, ToolError } from "@grasp-os/connector-kit/connector";
import { segmentValuePattern } from "@grasp-os/connector-kit/manifest";
import { providerFetch } from "@grasp-os/connector-kit/provider";
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
export const mailboxSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(segmentValuePattern);

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

const graphErrorSchema = z.object({
  error: z.object({ code: z.string() }),
});

/**
 * Graph, through connect's egress. Its error code (`ErrorItemNotFound`) is
 * passed on, never its message. Every tool sends at most one write, as its
 * last request (mail.move's folder lookup before it is a read), which is
 * what lets a 429 say nothing was done.
 */
const graph = providerFetch({
  name: "Microsoft 365",
  errorCodeOf: (body) => graphErrorSchema.safeParse(body).data?.error.code,
  invalidStatuses: [400, 409, 413, 422],
});

/** Sends one request to Graph: its answer if it succeeded, else a ToolError. */
export const graphFetch = graph.fetch;

/** Graph's JSON answer, checked against what the tool expects of it. */
export const graphJson = graph.json;

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
