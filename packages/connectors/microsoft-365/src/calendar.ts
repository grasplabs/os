import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import { z } from "zod";

import {
  atPage,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  mailboxSchema,
  nextPageOf,
  pageOf,
  pageSchema,
  segment,
  topSchema,
  v1,
} from "./graph.ts";

// Calendars, of one mailbox per call, as `/users/{mailbox}` like mail: the
// same resource, so a permission for invoices@ covers its calendar too.
// Times come back in UTC.

const users = `${v1}/users/{mailbox}`;

const graphTime = z.object({ dateTime: z.string(), timeZone: z.string() });

const graphAttendee = z.object({
  type: z.string().nullish(),
  status: z.object({ response: z.string().nullish() }).nullish(),
  emailAddress: z
    .object({ name: z.string().nullish(), address: z.string().nullish() })
    .nullish(),
});

const graphEvent = z.object({
  id: z.string(),
  subject: z.string().nullish(),
  bodyPreview: z.string().nullish(),
  body: z.object({ contentType: z.string(), content: z.string() }).nullish(),
  start: graphTime,
  end: graphTime,
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  showAs: z.string().nullish(),
  location: z.object({ displayName: z.string().nullish() }).nullish(),
  organizer: graphAttendee.nullish(),
  attendees: z.array(graphAttendee).nullish(),
  webLink: z.string().nullish(),
  onlineMeeting: z.object({ joinUrl: z.string().nullish() }).nullish(),
});
type GraphEvent = z.infer<typeof graphEvent>;

const summaryFields = [
  "id",
  "subject",
  "bodyPreview",
  "start",
  "end",
  "isAllDay",
  "isCancelled",
  "showAs",
  "location",
  "organizer",
  "webLink",
].join(",");

const timeSchema = z.strictObject({
  dateTime: z.string(),
  timeZone: z.string(),
});

const personSchema = z.strictObject({
  name: z.string().nullable(),
  address: z.string().nullable(),
});

const summarySchema = z.strictObject({
  mailbox: z.string(),
  id: z.string(),
  subject: z.string().nullable(),
  bodyPreview: z.string().nullable(),
  start: timeSchema,
  end: timeSchema,
  isAllDay: z.boolean(),
  isCancelled: z.boolean(),
  showAs: z.string().nullable(),
  location: z.string().nullable(),
  organizer: personSchema.nullable(),
  webLink: z.string().nullable(),
});

const personOf = (
  attendee: z.infer<typeof graphAttendee>
): z.infer<typeof personSchema> => ({
  name: attendee.emailAddress?.name ?? null,
  address: attendee.emailAddress?.address ?? null,
});

const summaryOf = (
  mailbox: string,
  event: GraphEvent
): z.infer<typeof summarySchema> => ({
  mailbox,
  id: event.id,
  subject: event.subject ?? null,
  bodyPreview: event.bodyPreview ?? null,
  start: event.start,
  end: event.end,
  isAllDay: event.isAllDay ?? false,
  isCancelled: event.isCancelled ?? false,
  showAs: event.showAs ?? null,
  location: event.location?.displayName ?? null,
  organizer: event.organizer ? personOf(event.organizer) : null,
  webLink: event.webLink ?? null,
});

/** Times in UTC, whatever the mailbox's own time zone. */
const inUtc: HeadersInit = { prefer: 'outlook.timezone="UTC"' };

const listEvents = defineTool({
  name: "calendar.list",
  description:
    "Lists the events of a mailbox's calendar that fall in a range of time, recurring ones as their occurrences, earliest first.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    top: topSchema,
    page: pageSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    events: z.array(summarySchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  resource: "mailbox",
  mask: ["events.subject", "events.bodyPreview"],
  routes: [{ method: "GET", host: graphHost, path: `${users}/calendarView` }],
  run: async ({ mailbox, start, end, top, page }) => {
    if (Date.parse(end) <= Date.parse(start)) {
      throw new ToolError("The range must end after it starts", {
        code: "invalid_request",
      });
    }
    const url = atPage(
      graphUrl(`/users/${segment(mailbox)}/calendarView`, {
        startDateTime: start,
        endDateTime: end,
        $select: summaryFields,
        $orderby: "start/dateTime",
        $top: String(top ?? 25),
      }),
      page
    );
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      url,
      pageOf(graphEvent),
      { headers: inUtc }
    );
    return {
      output: {
        mailbox,
        events: value.map((event) => summaryOf(mailbox, event)),
        nextPage: nextPageOf(nextLink),
      },
      provenance: value.map(({ id }) => id),
    };
  },
});

const getEvent = defineTool({
  name: "calendar.get",
  description:
    "Gets one event of a mailbox's calendar, with its body and attendees.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    event: idSchema,
  }),
  output: z.strictObject({
    event: summarySchema.extend({
      body: z
        .strictObject({ contentType: z.string(), content: z.string() })
        .nullable(),
      attendees: z.array(
        personSchema.extend({
          type: z.string().nullable(),
          response: z.string().nullable(),
        })
      ),
      joinUrl: z.string().nullable(),
    }),
  }),
  readOnly: true,
  resource: "mailbox",
  mask: ["event.subject", "event.bodyPreview", "event.body"],
  routes: [{ method: "GET", host: graphHost, path: `${users}/events/{event}` }],
  run: async ({ mailbox, event: id }) => {
    const event = await graphJson(
      graphUrl(`/users/${segment(mailbox)}/events/${segment(id)}`, {
        $select: `${summaryFields},body,attendees,onlineMeeting`,
      }),
      graphEvent,
      {
        headers: {
          prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
        },
      }
    );
    return {
      output: {
        event: {
          ...summaryOf(mailbox, event),
          body: event.body ?? { contentType: "text", content: "" },
          attendees: (event.attendees ?? []).map((attendee) => ({
            ...personOf(attendee),
            type: attendee.type ?? null,
            response: attendee.status?.response ?? null,
          })),
          joinUrl: event.onlineMeeting?.joinUrl ?? null,
        },
      },
      provenance: [event.id],
    };
  },
});

export const calendarTools = [listEvents, getEvent];
