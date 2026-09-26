import { defineTool, ToolError } from "@grasp-os/connector-kit/connector";
import { z } from "zod";

import {
  apisHost,
  googleJson,
  googleUrl,
  idSchema,
  nextPageOf,
  pageSchema,
  segment,
  topSchema,
} from "./google.ts";

// Calendars, one per call, as `/calendar/v3/calendars/{calendar}` with the
// calendar's ID, so a call's capability binds every request to it. Times
// come back in UTC.
//
// Which calendars. A calendar's ID is an address: a person's own calendar
// is their email address, other calendars `...@group.calendar.google.com`.
// Google's `primary` alias isn't one, so it is refused, as `me` is for
// mail. Nor are the calendars whose IDs hold a `#` (national holidays,
// `en.dutch#holiday@group.v.calendar.google.com`, and contacts' birthdays,
// `addressbook#contacts@group.v.calendar.google.com`): a `#` can't stand
// in a path parameter, which the egress refuses so a value can't end the
// path early. Those calendars hold no organization's data, so they are
// left out rather than widening what a parameter may hold.

const calendars = "/calendar/v3/calendars/{calendar}";

/**
 * A calendar's ID: one address, and nothing the egress refuses in a path
 * parameter, `#` included.
 */
const calendarSchema = z
  .string()
  .min(3)
  .max(256)
  .regex(/^[^/\\?#%;:@\s]+@[^/\\?#%;:@\s]+$/u);

const googleTime = z.object({
  dateTime: z.string().nullish(),
  date: z.string().nullish(),
});

const googlePerson = z.object({
  email: z.string().nullish(),
  displayName: z.string().nullish(),
});

const googleEvent = z.object({
  id: z.string(),
  status: z.string().nullish(),
  htmlLink: z.string().nullish(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  start: googleTime,
  end: googleTime,
  organizer: googlePerson.nullish(),
  recurringEventId: z.string().nullish(),
  attendees: z
    .array(
      googlePerson.extend({
        responseStatus: z.string().nullish(),
        optional: z.boolean().nullish(),
      })
    )
    .nullish(),
  hangoutLink: z.string().nullish(),
});
type GoogleEvent = z.infer<typeof googleEvent>;

const personSchema = z.strictObject({
  name: z.string().nullable(),
  address: z.string().nullable(),
});

const summarySchema = z.strictObject({
  calendar: z.string(),
  id: z.string(),
  subject: z.string().nullable(),
  /** A time in UTC, or a date for an all-day event. */
  start: z.string(),
  end: z.string(),
  isAllDay: z.boolean(),
  isCancelled: z.boolean(),
  location: z.string().nullable(),
  organizer: personSchema.nullable(),
  recurringEventId: z.string().nullable(),
  webLink: z.string().nullable(),
});

const personOf = (
  person: z.infer<typeof googlePerson>
): z.infer<typeof personSchema> => ({
  name: person.displayName ?? null,
  address: person.email ?? null,
});

const summaryOf = (
  calendar: string,
  event: GoogleEvent
): z.infer<typeof summarySchema> => ({
  calendar,
  id: event.id,
  subject: event.summary ?? null,
  start: event.start.dateTime ?? event.start.date ?? "",
  end: event.end.dateTime ?? event.end.date ?? "",
  isAllDay:
    typeof event.start.dateTime !== "string" &&
    typeof event.start.date === "string",
  isCancelled: event.status === "cancelled",
  location: event.location ?? null,
  organizer: event.organizer ? personOf(event.organizer) : null,
  recurringEventId: event.recurringEventId ?? null,
  webLink: event.htmlLink ?? null,
});

const eventPage = z.object({
  items: z.array(googleEvent).nullish(),
  nextPageToken: z.string().nullish(),
});

const listEvents = defineTool({
  name: "calendar.list",
  description:
    "Lists the events of a calendar that fall in a range of time, recurring ones as their occurrences, earliest first, in UTC.",
  input: z.strictObject({
    calendar: calendarSchema,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    top: topSchema(100),
    page: pageSchema,
  }),
  output: z.strictObject({
    calendar: z.string(),
    events: z.array(summarySchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  resource: "calendar",
  mask: ["events.subject"],
  routes: [{ method: "GET", host: apisHost, path: `${calendars}/events` }],
  run: async ({ calendar, start, end, top, page }) => {
    if (Date.parse(end) <= Date.parse(start)) {
      throw new ToolError("The range must end after it starts", {
        code: "invalid_request",
      });
    }
    const { items, nextPageToken } = await googleJson(
      googleUrl(
        apisHost,
        `/calendar/v3/calendars/${segment(calendar)}/events`,
        {
          timeMin: start,
          timeMax: end,
          singleEvents: "true",
          orderBy: "startTime",
          timeZone: "UTC",
          maxResults: String(top ?? 25),
        },
        page
      ),
      eventPage
    );
    const events = items ?? [];
    return {
      output: {
        calendar,
        events: events.map((event) => summaryOf(calendar, event)),
        nextPage: nextPageOf(nextPageToken ?? undefined),
      },
      provenance: events.map(({ id }) => id),
    };
  },
});

const getEvent = defineTool({
  name: "calendar.get",
  description:
    "Gets one event of a calendar, with its description and attendees, in UTC.",
  input: z.strictObject({
    calendar: calendarSchema,
    event: idSchema,
  }),
  output: z.strictObject({
    event: summarySchema.extend({
      body: z.string().nullable(),
      attendees: z.array(
        personSchema.extend({
          response: z.string().nullable(),
          optional: z.boolean(),
        })
      ),
      joinUrl: z.string().nullable(),
    }),
  }),
  readOnly: true,
  resource: "calendar",
  mask: ["event.subject", "event.body"],
  routes: [
    { method: "GET", host: apisHost, path: `${calendars}/events/{event}` },
  ],
  run: async ({ calendar, event: id }) => {
    const event = await googleJson(
      googleUrl(
        apisHost,
        `/calendar/v3/calendars/${segment(calendar)}/events/${segment(id)}`,
        { timeZone: "UTC" }
      ),
      googleEvent
    );
    return {
      output: {
        event: {
          ...summaryOf(calendar, event),
          body: event.description ?? "",
          attendees: (event.attendees ?? []).map((attendee) => ({
            ...personOf(attendee),
            response: attendee.responseStatus ?? null,
            optional: attendee.optional ?? false,
          })),
          joinUrl: event.hangoutLink ?? null,
        },
      },
      provenance: [event.id],
    };
  },
});

export const calendarTools = [listEvents, getEvent];
