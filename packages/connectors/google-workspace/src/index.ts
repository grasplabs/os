import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarTools } from "./calendar.ts";
import { driveTools } from "./drive.ts";
import { gmailTools } from "./gmail.ts";
import { apisHost, gmailHost } from "./google.ts";

/**
 * Native Google Workspace connector, on Google's APIs: Gmail of one
 * mailbox, one calendar, and the files of one shared drive, per call.
 *
 * Scopes, the least the tools need: `gmail.modify` (read, label, draft
 * and send; applying labels to a message needs it, and it can't delete
 * for good), `calendar.events.readonly` (events only, not calendar
 * settings or sharing) and `drive.readonly` (reading a file's content
 * needs it).
 *
 * Maskable fields, by name, as the Microsoft 365 connector's: `subject`,
 * `bodyPreview` and `body` (messages; events' titles and descriptions)
 * and `content` (attachments and files). A metadata-only permission
 * masking all four still shows: senders and recipients, dates, labels,
 * the read and draft flags, thread IDs; attachments' names, types and
 * sizes; events' times, location, organizer and attendees; files' names,
 * types, sizes and folders. It can't search mail or files (their search
 * looks through masked fields).
 */
export default defineConnector({
  name: "google-workspace",
  version: "0.2.0",
  provider: "google",
  scopes: [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar.events.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
  ],
  hosts: [gmailHost, apisHost],
  tools: [...gmailTools, ...calendarTools, ...driveTools],
});
