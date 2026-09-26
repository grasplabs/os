import {
  apisHost,
  gmailHost,
} from "@grasp-os/connector-google-workspace/google";
/**
 * Gmail, Calendar and Drive, as the Google Workspace connector reaches
 * them through connect's egress, serving the recorded answers in
 * test/fixtures/google.ts. Any other host takes whatever it is sent, as an
 * attacker's would. `rateLimit403` makes Google refuse the next request as
 * Drive and Calendar do when they rate limit.
 */
import { egressHeader } from "@grasp-os/connector-kit/manifest";
import { beforeEach } from "vite-plus/test";
import { z } from "zod";

import {
  allDayEvent,
  attachmentBody,
  bodyAttachment,
  cancelledOccurrence,
  cancelledOccurrenceId,
  contentOf,
  detachedBody,
  detachedMessageFull,
  draftId,
  eventDetail,
  eventPage,
  filePage,
  files,
  googleError,
  labelled,
  htmlBody,
  incompleteEvent,
  incompleteEventId,
  labels,
  messageFull,
  messageList,
  messageId,
  messageMetadata,
  notFound,
  overLimitAttachment,
  plainBody,
  searchResults,
  sentId,
} from "./fixtures/google.ts";
import { fakeProvider, json, route } from "./internet.ts";
import type { ProviderRoute } from "./internet.ts";

const users = String.raw`^/gmail/v1/users/(?<mailbox>[^/]+)`;
const calendars = String.raw`^/calendar/v3/calendars/(?<calendar>[^/]+)`;

const parts = ["mailbox", "calendar", "message", "id"] as const;

type Part = (typeof parts)[number];

/** The number of a message or event ID of the fixtures. */
const numberOf = (id: string): number => Number(id.at(-1)) || 1;

const modifySchema = z.object({
  addLabelIds: z.array(z.string()),
  removeLabelIds: z.array(z.string()),
});

/** A message listed, but deleted before its read. */
export const deletedMessageId = "19a0f00df00df00d";

/** A message whose read Google answers posing as connect's egress. */
export const spoofedMessageId = "19a0ffffffffffff";

export const fakeGoogle = () => {
  /** The attachment IDs each message's reads gave out, and their content. */
  const attachments = new Map<string, { size: number; data: string }>();

  const routes: ProviderRoute<Part>[] = [
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
          headers: { [egressHeader]: "refused" },
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
      attachments.set(`${id}/${attachmentId}`, attachmentBody);
      attachments.set(`${id}/${attachmentId}text`, bodyAttachment(plainBody));
      attachments.set(`${id}/${attachmentId}html`, bodyAttachment(htmlBody));
      const n = numberOf(id);
      if (n === detachedBody.understated) {
        attachments.set(`${id}/${attachmentId}huge`, overLimitAttachment);
      }
      return json(
        Object.values(detachedBody).some((each) => each === n)
          ? detachedMessageFull(mailbox, n, attachmentId)
          : messageFull(mailbox, n, attachmentId)
      );
    }),
    route(
      gmailHost,
      "GET",
      `${users}/messages/(?<message>[^/]+)/attachments/(?<id>[^/]+)`,
      ({ message, id }) => {
        const found = attachments.get(`${message}/${id}`);
        return found === undefined
          ? json(googleError(400, "INVALID_ARGUMENT", "invalidArgument"), 400)
          : json(found);
      }
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
      ({ calendar, id }) => {
        if (id === cancelledOccurrenceId(calendar)) {
          return json(cancelledOccurrence(calendar));
        }
        if (id === incompleteEventId(calendar)) {
          return json(incompleteEvent(calendar));
        }
        return json(
          id.endsWith("3")
            ? allDayEvent(calendar)
            : eventDetail(calendar, numberOf(id))
        );
      }
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
        if (query.get("alt") === "media") {
          return new Response(contentOf(id, null));
        }
        // Google answers with the fields asked for: the drive check's only.
        return json(
          query.get("fields") === "driveId" ? { driveId: found.driveId } : found
        );
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

  beforeEach(() => {
    attachments.clear();
  });
  const { sent, writesDone, fail } = fakeProvider({
    hosts: [gmailHost, apisHost],
    parts,
    routes,
    unmatched: () =>
      json(googleError(400, "INVALID_ARGUMENT", "badRequest"), 400),
  });
  return {
    sent,
    /** The writes Google carried out. */
    writesDone,
    /** Makes Google refuse the next request as Drive and Calendar rate limit. */
    rateLimit403: () => {
      fail({
        status: 403,
        body: googleError(403, "PERMISSION_DENIED", "userRateLimitExceeded"),
      });
    },
  };
};
