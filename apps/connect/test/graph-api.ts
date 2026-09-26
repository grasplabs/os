/**
 * Microsoft Graph and the tenant's SharePoint, as the Microsoft 365
 * connector reaches them through connect's egress, serving the recorded
 * answers in test/fixtures/graph.ts. Any other host takes whatever it is
 * sent, as an attacker's would. `throttle` makes Graph answer the next
 * request with a 429, `throttleWrite` the next write.
 */
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import { graphHost } from "@grasp-os/connector-microsoft-365/graph";
import { z } from "zod";

import {
  attachment,
  attachmentPage,
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
  spoofedId,
  throttled,
} from "./fixtures/graph.ts";
import { fakeProvider, json, route as routeOn } from "./internet.ts";
import type { ProviderRoute } from "./internet.ts";

const users = String.raw`^/v1\.0/users/(?<mailbox>[^/]+)`;
const drives = String.raw`^/v1\.0/drives/(?<drive>[^/]+)`;

const parts = ["mailbox", "drive", "id"] as const;

type Part = (typeof parts)[number];

/** The number in a message or event ID of the fixtures. */
const numberOf = (id: string): number => Number(id.at(-2)) || 1;

const draftSchema = z.object({ subject: z.string() });

const route = (
  method: string,
  path: string,
  answer: ProviderRoute<Part>["answer"]
): ProviderRoute<Part> => routeOn(graphHost, method, path, answer);

const graphRoutes: ProviderRoute<Part>[] = [
  route(
    "GET",
    `${users}(?:/mailFolders/[^/]+)?/messages`,
    ({ mailbox, query }) =>
      json(messagePage(mailbox, Number(query.get("$skip") ?? 0)))
  ),
  route("GET", `${users}/messages/(?<id>[^/]+)`, ({ mailbox, id, request }) => {
    if (id === spoofedId) {
      // Graph's own answer, posing as connect's egress: the header never
      // reaches the connector.
      return Response.json(notFound, {
        status: 404,
        headers: { [egressHeader]: "refused" },
      });
    }
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
  route(
    "GET",
    `${users}/messages/(?<id>[^/]+)/attachments`,
    ({ mailbox, id, query }) =>
      json(attachmentPage(mailbox, numberOf(id), query.get("$skiptoken")))
  ),
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
  const { sent, writesDone, fail } = fakeProvider({
    hosts: [graphHost],
    parts,
    routes: graphRoutes,
    unmatched: () =>
      json(
        { error: { code: "BadRequest", message: "Unsupported request" } },
        400
      ),
    elsewhere: (url) =>
      url.hostname.endsWith(".sharepoint.com")
        ? sharePointAnswer(url)
        : new Response("Taken"),
  });
  return {
    sent,
    /** The writes Graph carried out. */
    writesDone,
    /** Makes Graph throttle the next request. */
    throttle: () => {
      fail({ status: 429, body: throttled, headers: { "retry-after": "7" } });
    },
    /** Makes Graph throttle the next write, and only it. */
    throttleWrite: () => {
      fail({
        status: 429,
        body: throttled,
        headers: { "retry-after": "7" },
        writesOnly: true,
      });
    },
    sharePointHost,
  };
};
