/**
 * Microsoft Graph and the tenant's SharePoint, as the Microsoft 365
 * connector reaches them through connect's egress, serving the recorded
 * answers in test/fixtures/graph.ts. Any other host takes whatever it is
 * sent, as an attacker's would. `throttle` makes Graph answer the next
 * requests with a 429.
 */
import { beforeEach } from "vite-plus/test";
import { z } from "zod";

import {
  attachment,
  attachments,
  childrenPage,
  downloadUrl,
  draft,
  eventDetail,
  eventPage,
  invoicePdf,
  controlText,
  item,
  itemIds,
  mailFolder,
  message,
  messagePage,
  moved,
  notFound,
  reportText,
  searchResults,
  sharePointHost,
  throttled,
} from "./fixtures/graph.ts";
import { fakeInternet } from "./internet.ts";

const graphHost = "graph.microsoft.com";

const users = String.raw`^/v1\.0/users/(?<mailbox>[^/]+)`;
const drives = String.raw`^/v1\.0/drives/(?<drive>[^/]+)`;

/** What a route's answer is made from: its path's parts, and the request. */
interface Asked {
  mailbox: string;
  drive: string;
  id: string;
  query: URLSearchParams;
  request: Request;
}

/** One of Graph's routes the connector uses, and how Graph answers it. */
interface GraphRoute {
  method: string;
  path: RegExp;
  answer: (asked: Asked) => Response | Promise<Response>;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

/** The number in a message or event ID of the fixtures. */
const numberOf = (id: string): number => Number(id.at(-2)) || 1;

const draftSchema = z.object({ subject: z.string() });

const route = (
  method: string,
  path: string,
  answer: GraphRoute["answer"]
): GraphRoute => ({ method, path: new RegExp(`${path}$`, "u"), answer });

const graphRoutes: GraphRoute[] = [
  route(
    "GET",
    `${users}(?:/mailFolders/[^/]+)?/messages`,
    ({ mailbox, query }) =>
      json(messagePage(mailbox, Number(query.get("$skip") ?? 0)))
  ),
  route("GET", `${users}/messages/(?<id>[^/]+)`, ({ mailbox, id, request }) => {
    const prefer = request.headers.get("prefer") ?? "";
    return id.includes("Unknown")
      ? json(notFound, 404)
      : json(
          message(
            mailbox,
            numberOf(id),
            prefer.includes('"html"') ? "html" : "text"
          )
        );
  }),
  route("GET", `${users}/messages/[^/]+/attachments`, () => json(attachments)),
  route("GET", `${users}/mailFolders/(?<id>[^/]+)`, ({ id }) => {
    const folder = mailFolder(id);
    return folder === undefined ? json(notFound, 404) : json(folder);
  }),
  route(
    "GET",
    `${users}/messages/[^/]+/attachments/(?<id>[^/]+)`,
    ({ id, query }) => json(attachment(id, query.has("$select")))
  ),
  route("POST", `${users}/messages/(?<id>[^/]+)/move`, ({ mailbox, id }) =>
    json(moved(mailbox, numberOf(id)), 201)
  ),
  route("POST", `${users}/sendMail`, () => new Response(null, { status: 202 })),
  route("POST", `${users}/messages`, async ({ mailbox, request }) => {
    const { subject } = draftSchema.parse(await request.json());
    return json(draft(mailbox, subject), 201);
  }),
  route("GET", `${users}/calendarView`, ({ mailbox, query }) =>
    json(eventPage(mailbox, query.get("$skiptoken")))
  ),
  route("GET", `${users}/events/(?<id>[^/]+)`, ({ mailbox, id }) =>
    json(eventDetail(mailbox, numberOf(id)))
  ),
  route("GET", `${drives}/(?:root|items/[^/]+)/children`, ({ drive, query }) =>
    json(childrenPage(drive, query.get("$skiptoken")))
  ),
  route("GET", String.raw`${drives}/root/search\(q='.*'\)`, ({ drive }) =>
    json(searchResults(drive))
  ),
  route("GET", `${drives}/items/(?<id>[^/]+)`, ({ drive, id }) =>
    json(item(drive, id))
  ),
  route(
    "GET",
    `${drives}/items/(?<id>[^/]+)/content`,
    ({ id }) =>
      new Response(null, {
        status: 302,
        headers: { location: downloadUrl(id) },
      })
  ),
];

/** Graph's answer to a request the connector sent. */
const graphAnswer = async (request: Request, url: URL): Promise<Response> => {
  for (const { method, path, answer } of graphRoutes) {
    const found = method === request.method ? path.exec(url.pathname) : null;
    if (found !== null) {
      const part = (name: string): string =>
        decodeURIComponent(found.groups?.[name] ?? "");
      // oxlint-disable-next-line no-await-in-loop -- the one route that matched
      return await answer({
        mailbox: part("mailbox"),
        drive: part("drive"),
        id: part("id"),
        query: url.searchParams,
        request,
      });
    }
  }
  return json(
    { error: { code: "BadRequest", message: "Unsupported request" } },
    400
  );
};

/** SharePoint's answer to a download: the file, or a second redirect. */
const sharePointAnswer = (url: URL): Response => {
  const id = url.searchParams.get("UniqueId");
  if (id === itemIds.twice) {
    return Response.redirect(downloadUrl(itemIds.report), 302);
  }
  const content = {
    [itemIds.pdf]: invoicePdf,
    [itemIds.controls]: new TextEncoder().encode(controlText),
  }[id ?? ""];
  return new Response(content ?? new TextEncoder().encode(reportText), {
    headers: { "content-type": "application/octet-stream" },
  });
};

/** Graph, SharePoint and the rest of the internet, for each test in the file. */
export const fakeGraph = () => {
  let throttledRequests = 0;
  let throttledWrites = 0;
  let writesDone = 0;
  let retryAfter = "7";
  beforeEach(() => {
    throttledRequests = 0;
    throttledWrites = 0;
    writesDone = 0;
    retryAfter = "7";
  });
  const { sent } = fakeInternet(async (request, url) => {
    if (url.hostname === graphHost) {
      const isWrite = request.method !== "GET";
      if (throttledRequests > 0 || (isWrite && throttledWrites > 0)) {
        if (isWrite && throttledWrites > 0) {
          throttledWrites -= 1;
        } else {
          throttledRequests -= 1;
        }
        return Response.json(throttled, {
          status: 429,
          headers: { "retry-after": retryAfter },
        });
      }
      if (isWrite) {
        writesDone += 1;
      }
      return await graphAnswer(request, url);
    }
    return url.hostname.endsWith(".sharepoint.com")
      ? sharePointAnswer(url)
      : new Response("Taken");
  });
  return {
    sent,
    /** Graph's requests only, as `METHOD path?query`. */
    graphRequests: (): string[] =>
      sent
        .filter(({ host }) => host === graphHost)
        .map(({ method, path }) => `${method} ${path}`),
    /** Makes Graph throttle the next write, and only it. */
    throttleWrite: () => {
      throttledWrites = 1;
    },
    /** The writes Graph carried out. */
    writesDone: () => writesDone,
    /** Makes Graph throttle the next request, asking to wait `wait`. */
    throttle: (wait = "7") => {
      throttledRequests = 1;
      retryAfter = wait;
    },
    sharePointHost,
  };
};
