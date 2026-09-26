/**
 * Google's answers, in the shapes the Gmail v1, Calendar v3 and Drive v3
 * references document (Gmail's IDs-only lists and MIME part trees with
 * base64url bodies, Drive's int64 sizes as strings, Google's error body
 * with its `errors[].reason`), with example.com addresses and made-up
 * names and IDs of the forms Google gives them. The fake Google
 * (test/google-api.ts) serves them per mailbox, calendar and drive, so a
 * test can tell whose data an answer holds.
 */
import { base64, invoicePdf } from "./graph.ts";

/** A mailbox the tests' Apps use, and its own calendar. */
export const invoices = "invoices@example.com";

/** Another mailbox of the same organization. */
export const ceo = "ceo@example.com";

/** A team calendar. */
export const teamCalendar = "c_7f3e9a1b2c4d5e6f@group.calendar.google.com";

/** A national holidays calendar: its ID holds a `#`. */
export const holidayCalendar = "en.dutch#holiday@group.v.calendar.google.com";

/** A shared drive, and another one. */
export const financeDrive = "0AKsR3pQ9xLmUUk9PVA";
export const otherDrive = "0ABzY9xW8vU7tUk9PVA";

const prefix = (mailbox: string): string =>
  mailbox === invoices ? "19a0" : "19b0";

/** A message ID of `mailbox`, as Gmail shapes them: 16 hex digits. */
export const messageId = (mailbox: string, n: number): string =>
  `${prefix(mailbox)}c3d4e5f6a70${n}`;

/** A thread ID of `mailbox`. */
export const threadId = (mailbox: string, n: number): string =>
  `${prefix(mailbox)}c3d4e5f6a60${n}`;

/** The page token Gmail hands out after the first page. */
export const messagePageToken = "08123456789012345678";

/** Base64url, as Gmail sends bodies and attachments. */
export const base64Url = (bytes: Uint8Array): string =>
  base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");

const text = (value: string): string =>
  base64Url(new TextEncoder().encode(value));

const header = (name: string, value: string) => ({ name, value });

const subjectOf = (n: number): string =>
  `Invoice 2026-004${n} from Northwind Supplies`;

/** The headers of message `n`, as `format=metadata` or `full` has them. */
const headersOf = (mailbox: string, n: number) => [
  header("Subject", subjectOf(n)),
  header("From", '"Northwind Billing" <billing@northwind.example.org>'),
  header("To", `Invoices <${mailbox}>, "Doe, Jane" <jane@example.com>`),
  header("Cc", "controller@example.com"),
  header("Message-ID", `<CAF${n}x9Yq@mail.northwind.example.org>`),
];

/** Message `n` of `mailbox`, as `format=metadata` returns it. */
export const messageMetadata = (mailbox: string, n: number) => ({
  id: messageId(mailbox, n),
  threadId: threadId(mailbox, n),
  labelIds: n === 1 ? ["UNREAD", "IMPORTANT", "INBOX", "Label_7"] : ["INBOX"],
  snippet: `Dear customer, please find attached invoice 2026-004${n} for EUR 1,250.00`,
  sizeEstimate: 48_213,
  historyId: "8812345",
  internalDate: String(Date.UTC(2026, 8, 25 - n, 8, 10 + n)),
  payload: { mimeType: "multipart/mixed", headers: headersOf(mailbox, n) },
});

/** The first page of `mailbox`'s messages (two), or the rest (one). */
export const messageList = (mailbox: string, token: string | null) =>
  token === null
    ? {
        messages: [1, 2].map((n) => ({
          id: messageId(mailbox, n),
          threadId: threadId(mailbox, n),
        })),
        nextPageToken: messagePageToken,
        resultSizeEstimate: 3,
      }
    : {
        messages: [
          { id: messageId(mailbox, 3), threadId: threadId(mailbox, 3) },
        ],
        resultSizeEstimate: 3,
      };

/** The part IDs of message 1's attachments. */
export const partIds = { pdf: "1", big: "2", inline: "3" } as const;

/** Message 1's plain-text body. */
export const plainBody =
  "Dear customer,\r\n\r\nPlease find attached invoice 2026-0041 for EUR 1,250.00.\r\n";

export const htmlBody =
  "<p>Dear customer,</p><p>Please find attached invoice 2026-0041.</p>";

/** A small inline signature image, sent inline in the part itself. */
export const signaturePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

/**
 * Message `n` of `mailbox`, as `format=full` returns it: a part tree with
 * a text and an HTML body and three attachments. Gmail gives an attachment
 * a new `attachmentId` on every read: `attachmentId` is this read's.
 */
export const messageFull = (
  mailbox: string,
  n: number,
  attachmentId: string
) => ({
  ...messageMetadata(mailbox, n),
  payload: {
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      ...headersOf(mailbox, n),
      header("Bcc", "audit@example.com"),
      header("Reply-To", "Accounts <accounts@northwind.example.org>"),
    ],
    body: { size: 0 },
    parts: [
      {
        partId: "0",
        mimeType: "multipart/alternative",
        filename: "",
        headers: [],
        body: { size: 0 },
        parts: [
          {
            partId: "0.0",
            mimeType: "text/plain",
            filename: "",
            headers: [header("Content-Type", 'text/plain; charset="UTF-8"')],
            body: { size: plainBody.length, data: text(plainBody) },
          },
          {
            partId: "0.1",
            mimeType: "text/html",
            filename: "",
            headers: [header("Content-Type", 'text/html; charset="UTF-8"')],
            body: { size: htmlBody.length, data: text(htmlBody) },
          },
        ],
      },
      {
        partId: partIds.pdf,
        mimeType: "application/pdf",
        filename: "Invoice-2026-0041.pdf",
        headers: [
          header(
            "Content-Disposition",
            'attachment; filename="Invoice-2026-0041.pdf"'
          ),
        ],
        body: { attachmentId, size: invoicePdf.byteLength },
      },
      {
        partId: partIds.big,
        mimeType: "application/zip",
        filename: "scans.zip",
        headers: [header("Content-Disposition", "attachment")],
        body: { attachmentId: `${attachmentId}big`, size: 5 * 1024 * 1024 },
      },
      {
        partId: partIds.inline,
        mimeType: "image/png",
        filename: "signature.png",
        headers: [header("Content-Disposition", "inline")],
        body: { size: signaturePng.byteLength, data: base64Url(signaturePng) },
      },
    ],
  },
});

/**
 * The numbers of the messages whose bodies Gmail doesn't send inline: one
 * whose text and HTML bodies are behind attachment IDs, one whose body is
 * past the read limit, one with no body part at all, and one whose body
 * and attachment Gmail says are small but whose content is past the limit.
 */
export const detachedBody = {
  readable: 4,
  tooLarge: 5,
  none: 6,
  understated: 7,
} as const;

/** Groups of three bytes (`xxx`, base64 `eHh4`) past the 4 MiB read limit. */
const overLimitGroups = Math.ceil((4 * 1024 * 1024 + 1) / 3);

/**
 * Content past the read limit, as `GET .../attachments/{id}` returns it,
 * whatever size the message said it had.
 */
export const overLimitAttachment = {
  size: overLimitGroups * 3,
  data: "eHh4".repeat(overLimitGroups),
};

/** A body part whose data is behind `attachmentId`. */
const detachedPart = (
  partId: string,
  mimeType: string,
  attachmentId: string,
  size: number
) => ({
  partId,
  mimeType,
  filename: "",
  headers: [header("Content-Type", `${mimeType}; charset="UTF-8"`)],
  body: { attachmentId, size },
});

/**
 * Message `n` of `detachedBody`, as `format=full` returns it. A body part's
 * attachment ID is this read's, with `text` or `html` after it, or `huge`
 * for content past the limit.
 */
export const detachedMessageFull = (
  mailbox: string,
  n: number,
  attachmentId: string
) => {
  const bodies = {
    [detachedBody.readable]: [
      detachedPart("0", "text/plain", `${attachmentId}text`, plainBody.length),
      detachedPart("1", "text/html", `${attachmentId}html`, htmlBody.length),
    ],
    [detachedBody.tooLarge]: [
      detachedPart("0", "text/plain", `${attachmentId}text`, 5 * 1024 * 1024),
    ],
    [detachedBody.understated]: [
      detachedPart("0", "text/plain", `${attachmentId}huge`, plainBody.length),
    ],
  }[n];
  const attachment =
    n === detachedBody.understated ? `${attachmentId}huge` : attachmentId;
  return {
    ...messageMetadata(mailbox, n),
    payload: {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: headersOf(mailbox, n),
      body: { size: 0 },
      parts: [
        ...(bodies ?? []),
        {
          partId: "9",
          mimeType: "application/pdf",
          filename: "Invoice-2026-0041.pdf",
          headers: [header("Content-Disposition", "attachment")],
          body: { attachmentId: attachment, size: invoicePdf.byteLength },
        },
      ],
    },
  };
};

/** A detached body part's content, as `GET .../attachments/{id}` returns it. */
export const bodyAttachment = (content: string) => ({
  size: content.length,
  data: text(content),
});

/** An attachment's content, as `GET .../attachments/{id}` returns it. */
export const attachmentBody = {
  size: invoicePdf.byteLength,
  data: base64Url(invoicePdf),
};

export const labels = {
  labels: [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "UNREAD", name: "UNREAD", type: "system" },
    { id: "Label_7", name: "Invoices/2026", type: "user" },
  ],
};

/** A message once labelled, sent, or kept as a draft. */
export const labelled = (
  mailbox: string,
  id: string,
  labelIds: readonly string[]
) => ({
  id,
  threadId: threadId(mailbox, 1),
  labelIds,
});

export const sentId = (mailbox: string): string => messageId(mailbox, 8);
export const draftId = "r-4871632908115423771";

/** An event ID of `calendar`, as Google shapes them (base32hex). */
export const eventId = (calendar: string, n: number): string =>
  `${calendar.startsWith("c_") ? "4k1n7p" : "0a1b2c"}9q2r3s5t6u${n}`;

/** The page token Calendar hands out after the first page. */
export const eventPageToken =
  "CigKGjRrMW43cDlxMnIzczV0NnUxGAEggICA3uGo8xgaDQgAEgAYyL7Dm9K4-QI=";

const event = (calendar: string, n: number) => ({
  kind: "calendar#event",
  etag: `"33${n}1784200000000"`,
  id: eventId(calendar, n),
  status: "confirmed",
  htmlLink: `https://www.google.com/calendar/event?eid=${eventId(calendar, n)}`,
  summary: n === 1 ? "Month-end close" : "Supplier review",
  description:
    n === 1 ? "Agenda: open invoices over EUR 10,000." : "Quarterly review.",
  location: "Room 4.12",
  organizer: { email: "controller@example.com", displayName: "Controller" },
  start: { dateTime: `2026-09-2${8 + n}T09:00:00Z`, timeZone: "UTC" },
  end: { dateTime: `2026-09-2${8 + n}T10:00:00Z`, timeZone: "UTC" },
  attendees: [
    {
      email: "controller@example.com",
      displayName: "Controller",
      responseStatus: "accepted",
    },
    {
      email: "jane@example.com",
      responseStatus: "needsAction",
      optional: true,
    },
  ],
  hangoutLink: "https://meet.google.com/abc-defg-hij",
});

/** A page of `calendar`'s events: one per page, two in all. */
export const eventPage = (calendar: string, token: string | null) => ({
  kind: "calendar#events",
  summary: calendar,
  timeZone: "UTC",
  items: [event(calendar, token === null ? 1 : 2)],
  ...(token === null ? { nextPageToken: eventPageToken } : {}),
});

export const eventDetail = (calendar: string, n: number) => event(calendar, n);

/** An all-day event, as Google gives one: dates, no times. */
export const allDayEvent = (calendar: string) => ({
  ...event(calendar, 3),
  start: { date: "2026-10-01" },
  end: { date: "2026-10-02" },
});

/** An event that isn't cancelled, but that Google gave no start or end. */
export const incompleteEventId = (calendar: string): string =>
  eventId(calendar, 4);

export const incompleteEvent = (calendar: string) => {
  const { start: _start, end: _end, ...rest } = event(calendar, 4);
  return rest;
};

/** An occurrence's ID, as Google shapes them: its event's, and its start. */
export const cancelledOccurrenceId = (calendar: string): string =>
  `${eventId(calendar, 1)}_20261006T090000Z`;

/**
 * A cancelled occurrence of a recurring event, as `GET /events/{id}`
 * returns one: no start or end, only the start it had.
 */
export const cancelledOccurrence = (calendar: string) => ({
  kind: "calendar#event",
  etag: '"3341784200000000"',
  id: cancelledOccurrenceId(calendar),
  status: "cancelled",
  recurringEventId: eventId(calendar, 1),
  originalStartTime: { dateTime: "2026-10-06T09:00:00Z", timeZone: "UTC" },
});

/** File IDs, by what each is. */
export const fileIds = {
  folder: "1FdR9xQmLpZ3vT7wYc2bN5kJ8hG4sD6aE",
  report: "1RpT4kLmN8qW2eX6zC9vB3nM5jH7gF1dS",
  pdf: "1PdF7hJ3kL9mN2bV5cX8zQ4wE6rT1yU0i",
  doc: "1DoC2gHj4kL6mN8pQ0rS3tU5vW7xY9zA1b",
  sheet: "1ShT3eEt5gHj7kL9mN1pQ3rS5tU7vW9xY",
  form: "1FoRm8mN2bV4cX6zQ8wE0rT2yU4iO6pAs",
  big: "1BiG5fL3kJ9hG7fD5sA3pO1iU9yT7rE5w",
  /** A file of another shared drive. */
  foreign: "1FoR3iGn5dR7iV9eF1iL3eX5aM7pL9eQ",
  /** A file of someone's My Drive: no drive ID. */
  myDrive: "1MyD5rIv7eF9iL1eX3aM5pL7eQ9wR1tY",
  /** A shortcut, in the drive, to a file anywhere. */
  shortcut: "1ShOrTcUt7eF9iL1eX3aM5pL7eQ9wR1tZ",
  /** A file in the drive's trash. */
  trashed: "1TrAsHeD7eF9iL1eX3aM5pL7eQ9wR1tYx",
  /** An ID Google answers with another file of the drive. */
  alias: "1AlIaS5rIv7eF9iL1eX3aM5pL7eQ9wR1t",
} as const;

/** The page token Drive hands out after the first page. */
export const filePageToken =
  "~!!~AI9FV7Q3mN8pZ2xW5vT7rS9qP1oN3mL5kJ7hG9fD1sA3zX5cV7bN9mQ2wE4rT6yU8i";

export const reportText = "Month-end report\nRevenue: EUR 1,250,000\n";
export const docText = "﻿Supplier contract\r\nTerm: 12 months\r\n";
export const sheetCsv = "Invoice,Amount\r\n2026-0041,1250.00\r\n";

const file = (
  id: string,
  name: string,
  mimeType: string,
  fields: Record<string, unknown> = {}
) => ({
  id,
  name,
  mimeType,
  modifiedTime: "2026-09-24T16:02:11.000Z",
  webViewLink: `https://drive.google.com/file/d/${id}/view?usp=drivesdk`,
  parents: [financeDrive],
  driveId: financeDrive,
  ...fields,
});

/** Each file's metadata, as `GET /files/{id}` returns it. */
export const files: Record<string, ReturnType<typeof file>> = {
  [fileIds.folder]: file(
    fileIds.folder,
    "2026",
    "application/vnd.google-apps.folder"
  ),
  [fileIds.report]: file(fileIds.report, "Month-end report.txt", "text/plain", {
    size: String(new TextEncoder().encode(reportText).byteLength),
  }),
  [fileIds.pdf]: file(fileIds.pdf, "Invoice-2026-0041.pdf", "application/pdf", {
    size: String(invoicePdf.byteLength),
    parents: [fileIds.folder],
  }),
  [fileIds.doc]: file(
    fileIds.doc,
    "Supplier contract",
    "application/vnd.google-apps.document"
  ),
  [fileIds.sheet]: file(
    fileIds.sheet,
    "Invoices 2026",
    "application/vnd.google-apps.spreadsheet"
  ),
  [fileIds.form]: file(
    fileIds.form,
    "Supplier survey",
    "application/vnd.google-apps.form"
  ),
  [fileIds.big]: file(fileIds.big, "scans.zip", "application/zip", {
    size: String(5 * 1024 * 1024),
  }),
  [fileIds.foreign]: file(fileIds.foreign, "Board minutes.txt", "text/plain", {
    size: "120",
    parents: [otherDrive],
    driveId: otherDrive,
  }),
  [fileIds.myDrive]: file(fileIds.myDrive, "Salaries.txt", "text/plain", {
    size: "80",
    parents: ["0AMyDrIvErOoTfOlDeR"],
    driveId: undefined,
  }),
  [fileIds.shortcut]: file(
    fileIds.shortcut,
    "Board minutes (shortcut)",
    "application/vnd.google-apps.shortcut"
  ),
  [fileIds.trashed]: file(fileIds.trashed, "Old report.txt", "text/plain", {
    size: "40",
    trashed: true,
  }),
  [fileIds.alias]: file(fileIds.report, "Month-end report.txt", "text/plain", {
    size: "40",
  }),
};

/** A page of the drive's top folder: two items, then one. */
export const filePage = (token: string | null) =>
  token === null
    ? {
        nextPageToken: filePageToken,
        files: [files[fileIds.folder], files[fileIds.report]],
      }
    : { files: [files[fileIds.pdf]] };

/** What a search finds: an item of the drive, and one Google adds of another. */
export const searchResults = {
  files: [files[fileIds.pdf], files[fileIds.foreign]],
};

/** A file's content, as `alt=media` or `/export` returns it. */
export const contentOf = (id: string, exportType: string | null) => {
  if (exportType !== null) {
    return id === fileIds.sheet && exportType === "text/csv"
      ? sheetCsv
      : docText;
  }
  return id === fileIds.pdf ? invoicePdf : reportText;
};

/** Google's error answers. */
export const googleError = (code: number, status: string, reason: string) => ({
  error: {
    code,
    message: `The request failed (${reason}) for invoices@example.com`,
    status,
    errors: [{ message: "The request failed", domain: "global", reason }],
  },
});

export const notFound = googleError(404, "NOT_FOUND", "notFound");
