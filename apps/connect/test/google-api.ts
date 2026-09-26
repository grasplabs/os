/**
 * Gmail, Calendar and Drive, as the Google Workspace connector reaches
 * them through connect's egress, serving the recorded answers in
 * test/fixtures/google.ts. Any other host takes whatever it is sent, as an
 * attacker's would. `throttle` and the like make Google refuse the next
 * requests as it does when it rate limits or is down.
 */
import { beforeEach } from "vite-plus/test";
import { z } from "zod";

import {
  allDayEvent,
  attachmentBody,
  contentOf,
  draftId,
  eventDetail,
  eventPage,
  filePage,
  files,
  googleError,
  labelled,
  labels,
  messageFull,
  messageList,
  messageId,
  messageMetadata,
  notFound,
  searchResults,
  sentId,
} from "./fixtures/google.ts";
import { fakeInternet } from "./internet.ts";

const gmailHost = "gmail.googleapis.com";
const apisHost = "www.googleapis.com";

const users = String.raw`^/gmail/v1/users/(?<mailbox>[^/]+)`;
const calendars = String.raw`^/calendar/v3/calendars/(?<calendar>[^/]+)`;

/** What a route's answer is made from: its path's parts, and the request. */
interface Asked {
  mailbox: string;
  calendar: string;
  message: string;
  id: string;
  query: URLSearchParams;
  request: Request;
}

interface GoogleRoute {
  host: string;
  method: string;
  path: RegExp;
  answer: (asked: Asked) => Response | Promise<Response>;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

/** The number of a message or event ID of the fixtures. */
const numberOf = (id: string): number => Number(id.at(-1)) || 1;

const route = (
  host: string,
  method: string,
  path: string,
  answer: GoogleRoute["answer"]
): GoogleRoute => ({
  host,
  method,
  path: new RegExp(`${path}$`, "u"),
  answer,
});

const modifySchema = z.object({
  addLabelIds: z.array(z.string()),
  removeLabelIds: z.array(z.string()),
});

/** A message listed, but deleted before its read. */
export const deletedMessageId = "19a0f00df00df00d";

/** A message whose read Google answers posing as connect's egress. */
export const spoofedMessageId = "19a0ffffffffffff";

export const fakeGoogle = () => {
  /** The attachment IDs each message's reads gave out. */
  const attachmentIds = new Set<string>();

  const routes: GoogleRoute[] = [
    // A search for `deleted` finds more than asked for, one deleted since.
    route(gmailHost, "GET", `${users}/messages`, ({ mailbox, query }) =>
      query.get("q") === "deleted"
        ? json({
            messages: [
              messageId(mailbox, 1),
              deletedMessageId,
              messageId(mailbox, 2),
            ].map((id) => ({ id, threadId: id })),
          })
        : json(messageList(mailbox, query.get("pageToken")))
    ),
    route(gmailHost, "GET", `${users}/messages/(?<id>[^/]+)`, (asked) => {
      const { mailbox, id, query } = asked;
      if (id === spoofedMessageId) {
        return Response.json(notFound, {
          status: 404,
          headers: { "grasp-egress": "refused" },
        });
      }
      if (id.includes("f00d")) {
        return json(notFound, 404);
      }
      if (query.get("format") === "metadata") {
        return json(messageMetadata(mailbox, numberOf(id)));
      }
      // Each read gives the attachments new IDs, as Gmail's do.
      const attachmentId = `ANGjdJ_${crypto.randomUUID().replaceAll("-", "")}`;
      attachmentIds.add(`${id}/${attachmentId}`);
      return json(messageFull(mailbox, numberOf(id), attachmentId));
    }),
    route(
      gmailHost,
      "GET",
      `${users}/messages/(?<message>[^/]+)/attachments/(?<id>[^/]+)`,
      ({ message, id }) =>
        attachmentIds.has(`${message}/${id}`)
          ? json(attachmentBody)
          : json(googleError(400, "INVALID_ARGUMENT", "invalidArgument"), 400)
    ),
    route(gmailHost, "GET", `${users}/labels`, () => json(labels)),
    route(
      gmailHost,
      "POST",
      `${users}/messages/(?<id>[^/]+)/modify`,
      async ({ mailbox, id, request }) => {
        const { addLabelIds, removeLabelIds } = modifySchema.parse(
          await request.json()
        );
        const before = messageMetadata(mailbox, numberOf(id)).labelIds;
        return json(
          labelled(mailbox, id, [
            ...new Set([
              ...before.filter((label) => !removeLabelIds.includes(label)),
              ...addLabelIds,
            ]),
          ])
        );
      }
    ),
    route(gmailHost, "POST", `${users}/messages/send`, ({ mailbox }) =>
      json(labelled(mailbox, sentId(mailbox), ["SENT"]))
    ),
    route(gmailHost, "POST", `${users}/drafts`, ({ mailbox }) =>
      json({
        id: draftId,
        message: labelled(mailbox, sentId(mailbox), ["DRAFT"]),
      })
    ),
    route(apisHost, "GET", `${calendars}/events`, ({ calendar, query }) =>
      json(eventPage(calendar, query.get("pageToken")))
    ),
    route(
      apisHost,
      "GET",
      `${calendars}/events/(?<id>[^/]+)`,
      ({ calendar, id }) =>
        json(
          id.endsWith("3")
            ? allDayEvent(calendar)
            : eventDetail(calendar, numberOf(id))
        )
    ),
    route(apisHost, "GET", String.raw`^/drive/v3/files`, ({ query }) =>
      json(
        (query.get("q") ?? "").startsWith("fullText")
          ? searchResults
          : filePage(query.get("pageToken"))
      )
    ),
    route(
      apisHost,
      "GET",
      String.raw`^/drive/v3/files/(?<id>[^/]+)`,
      ({ id, query }) => {
        const found = files[id];
        if (found === undefined) {
          return json(notFound, 404);
        }
        return query.get("alt") === "media"
          ? new Response(contentOf(id, null))
          : json(found);
      }
    ),
    route(
      apisHost,
      "GET",
      String.raw`^/drive/v3/files/(?<id>[^/]+)/export`,
      ({ id, query }) =>
        new Response(contentOf(id, query.get("mimeType")), {
          headers: { "content-type": query.get("mimeType") ?? "" },
        })
    ),
  ];

  /** Google's answer to a request the connector sent. */
  const googleAnswer = async (
    request: Request,
    url: URL
  ): Promise<Response> => {
    for (const { host, method, path, answer } of routes) {
      const found =
        host === url.hostname && method === request.method
          ? path.exec(url.pathname)
          : null;
      if (found !== null) {
        const part = (name: string): string =>
          decodeURIComponent(found.groups?.[name] ?? "");
        // oxlint-disable-next-line no-await-in-loop -- the one route that matched
        return await answer({
          mailbox: part("mailbox"),
          calendar: part("calendar"),
          message: part("message"),
          id: part("id"),
          query: url.searchParams,
          request,
        });
      }
    }
    return json(googleError(400, "INVALID_ARGUMENT", "badRequest"), 400);
  };

  /** How Google fails the next request, or the next write only. */
  let failure:
    | {
        status: number;
        body: unknown;
        writesOnly: boolean;
        headers: HeadersInit;
      }
    | undefined;
  let writesDone = 0;
  beforeEach(() => {
    failure = undefined;
    writesDone = 0;
    attachmentIds.clear();
  });
  const { sent } = fakeInternet(async (request, url) => {
    if (url.hostname !== gmailHost && url.hostname !== apisHost) {
      return new Response("Taken");
    }
    const isWrite = request.method !== "GET";
    if (failure !== undefined && (isWrite || !failure.writesOnly)) {
      const { status, body, headers } = failure;
      failure = undefined;
      return Response.json(body, { status, headers });
    }
    if (isWrite) {
      writesDone += 1;
    }
    return await googleAnswer(request, url);
  });
  const rateLimited = googleError(
    429,
    "RESOURCE_EXHAUSTED",
    "rateLimitExceeded"
  );
  return {
    sent,
    /** The writes Google carried out. */
    writesDone: () => writesDone,
    /** Makes Google answer the next request 429, asking to wait `wait`. */
    throttle: (wait = "7") => {
      failure = {
        status: 429,
        body: rateLimited,
        writesOnly: false,
        headers: { "retry-after": wait },
      };
    },
    /** Makes Google answer the next write 429, and only it. */
    throttleWrite: () => {
      failure = {
        status: 429,
        body: rateLimited,
        writesOnly: true,
        headers: {},
      };
    },
    /** Makes Google refuse the next request as Drive and Calendar rate limit. */
    rateLimit403: () => {
      failure = {
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "userRateLimitExceeded"),
        writesOnly: false,
        headers: {},
      };
    },
    /** Makes Google answer the next request, or the next write, 503. */
    unavailable: (writesOnly = false) => {
      failure = {
        status: 503,
        body: googleError(503, "UNAVAILABLE", "backendError"),
        writesOnly,
        headers: { "retry-after": "5" },
      };
    },
  };
};
