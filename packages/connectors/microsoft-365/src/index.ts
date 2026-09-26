import { defineConnector } from "@grasp-os/connector-kit/connector";

import { calendarTools } from "./calendar.ts";
import { fileTools } from "./files.ts";
import { graphHost } from "./graph.ts";
import { mailTools } from "./mail.ts";

/**
 * Native Microsoft 365 connector, on Microsoft Graph: mail and calendars
 * of one mailbox per call, and files in OneDrive and SharePoint, one drive
 * per call.
 *
 * Maskable fields, by name: `subject`, `bodyPreview` and `body` (messages
 * and events) and `content` (attachments and files). A metadata-only
 * permission masking all four still shows: senders and recipients, dates,
 * read, draft and importance flags, folders and conversation IDs, links;
 * attachments' names, types and sizes; events' times, location, organizer
 * and attendees; files' names, types, sizes and folders. It can't search
 * mail or files (their search looks through masked fields).
 */
export default defineConnector({
  name: "microsoft-365",
  version: "0.2.0",
  provider: "microsoft",
  scopes: [
    "User.Read",
    "Mail.ReadWrite",
    "Mail.ReadWrite.Shared",
    "Mail.Send",
    "Mail.Send.Shared",
    "Calendars.Read",
    "Calendars.Read.Shared",
    "Files.Read.All",
    "Sites.Read.All",
  ],
  hosts: [graphHost],
  tools: [...mailTools, ...calendarTools, ...fileTools],
});
