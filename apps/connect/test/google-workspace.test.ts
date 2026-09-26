import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeConnector } from "../src/connectors.ts";
import { accessTokenFor } from "../src/tokens.ts";
import { connectAccount, outcome, ownAccount, someone } from "./connect.ts";
import {
  ceo,
  docText,
  draftId,
  eventId,
  eventPageToken,
  fileIds,
  filePageToken,
  financeDrive,
  holidayCalendar,
  htmlBody,
  invoices,
  messageId,
  messagePageToken,
  otherDrive,
  partIds,
  plainBody,
  reportText,
  sentId,
  sheetCsv,
  signaturePng,
  teamCalendar,
  threadId,
} from "./fixtures/google.ts";
import { base64, invoicePdf, pdfBase64 } from "./fixtures/graph.ts";
import {
  deletedMessageId,
  fakeGoogle,
  spoofedMessageId,
} from "./google-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import {
  callTool as call,
  outputOf,
  parsedRequests,
  refusalsFor,
  resultOf,
  retryable,
  toolError,
} from "./tool-calls.ts";
import type { Connection, Input } from "./tool-calls.ts";

// The Google Workspace connector against Google's recorded answers,
// through connect's real call path: capability, policy, a fresh isolate,
// the egress (which adds the token and holds each call to its routes),
// and back. Scoping comes first: a call for one mailbox, calendar or
// shared drive reaches only that one.

const providers = fakeProviders();
const google = fakeGoogle();

/** Someone's Google Workspace connection, made through OAuth. */
const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(
    providers,
    person,
    ownAccount(person, "google")
  );
  return { id, person };
};

/** What left connect, each request with its query and JSON body parsed. */
const requests = () => parsedRequests(google.sent);

const paths = (): string[] => requests().map(({ path }) => path);

/** UTF-8 text from base64 (MIME's, folded or not). */
const utf8 = (encoded: string): string =>
  new TextDecoder().decode(
    Uint8Array.from(
      atob(encoded.replaceAll("\r\n", "")),
      (character) => character.codePointAt(0) ?? 0
    )
  );

const mailboxPath = `/gmail/v1/users/${encodeURIComponent(invoices)}`;
const calendarPath = `/calendar/v3/calendars/${encodeURIComponent(teamCalendar)}`;

const manifest = connectorManifestSchema.parse(
  nativeConnector("google-workspace")?.manifest
);

/** Input for each Gmail tool, but its mailbox. */
const mailboxInputs: Record<string, Input> = {
  "mail.list": {},
  "mail.get": { message: messageId(ceo, 1) },
  "mail.readAttachment": { message: messageId(ceo, 1), attachment: "1" },
  "mail.labels": {},
  "mail.label": { message: messageId(ceo, 1), remove: ["INBOX"] },
  "mail.send": { subject: "Hi", body: "Hi", to: ["a@example.com"] },
  "mail.createDraft": { subject: "Hi", body: "Hi", to: ["a@example.com"] },
};

/** Input for each Calendar tool, but its calendar. */
const calendarInputs: Record<string, Input> = {
  "calendar.list": {
    start: "2026-09-28T00:00:00Z",
    end: "2026-10-05T00:00:00Z",
  },
  "calendar.get": { event: eventId(teamCalendar, 1) },
};

/** Input for each Drive tool, but its drive. */
const driveInputs: Record<string, Input> = {
  "files.list": {},
  "files.search": { query: "invoice" },
  "files.read": { item: fileIds.report },
};

describe("the Google Workspace connector's scoping", () => {
  it("binds every route of every tool to its mailbox, calendar or drive", () => {
    const routes = Object.entries(manifest.actions).flatMap(
      ([name, { resource, routes: declared }]) =>
        declared.map((route) => ({ name, resource, ...route }))
    );
    const unbound = routes
      .filter(
        ({ resource, path, query, check }) =>
          !(
            (resource === "mailbox" &&
              path.startsWith("/gmail/v1/users/{mailbox}/")) ||
            (resource === "calendar" &&
              path.startsWith("/calendar/v3/calendars/{calendar}/")) ||
            (resource === "drive" &&
              query?.driveId === "{drive}" &&
              query.corpora === "drive")
          ) && check === undefined
      )
      .map(({ name, path }) => `${name} ${path}`);
    expect(unbound).toStrictEqual([]);
    // Only a file read can't name its drive: Drive addresses a file by its
    // ID alone. The egress checks the file's drive with Google first.
    expect(
      routes
        .filter(({ check }) => check !== undefined)
        .map(({ name, check }) => ({ name, equals: check?.equals }))
    ).toStrictEqual([
      { name: "files.read", equals: "{drive}" },
      { name: "files.read", equals: "{drive}" },
    ]);
    expect(
      Object.keys(manifest.actions).toSorted(),
      "every tool is tested for scoping below"
    ).toStrictEqual(
      [
        ...Object.keys(mailboxInputs),
        ...Object.keys(calendarInputs),
        ...Object.keys(driveInputs),
      ].toSorted()
    );
    expect(manifest.hosts).toStrictEqual([
      "gmail.googleapis.com",
      "www.googleapis.com",
    ]);
    // No batch endpoint, and no redirect is ever followed.
    expect(
      routes.filter(
        ({ path, redirects }) => /batch/iu.test(path) || redirects !== undefined
      )
    ).toStrictEqual([]);
  });

  it("keeps a call for one mailbox out of every other, for every Gmail tool", async () => {
    const connection = await connected();
    // The capability is for invoices@; each call names ceo@, Google's
    // alias for the person's own, or a spelling Gmail would take for
    // invoices@ that isn't exactly it.
    await expect(
      refusalsFor(connection, mailboxInputs, "mailbox", invoices, [
        ceo,
        "me",
        "Invoices@example.com",
        `${invoices} `,
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(google.sent).toStrictEqual([]);
    await call(
      connection,
      "mail.labels",
      { mailbox: invoices },
      { resource: invoices }
    );
    expect(paths()).toStrictEqual([`${mailboxPath}/labels`]);
  });

  it("keeps a call for one calendar out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(connection, calendarInputs, "calendar", teamCalendar, [
        invoices,
        "primary",
        holidayCalendar,
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(google.sent).toStrictEqual([]);
  });

  it("keeps a call for one shared drive out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(connection, driveInputs, "drive", financeDrive, [
        otherDrive,
        financeDrive.toLowerCase(),
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(google.sent).toStrictEqual([]);
  });

  it("never takes Google's aliases, or a calendar ID a path can't hold, as a resource", async () => {
    const connection = await connected();
    // Even when a permission names one, the tool refuses it before
    // anything goes out.
    const event = eventId(invoices, 1);
    const refusals = await Promise.all(
      [
        { action: "mail.labels", resource: "me", input: { mailbox: "me" } },
        ...["primary", holidayCalendar].map((calendar) => ({
          action: "calendar.get",
          resource: calendar,
          input: { calendar, event },
        })),
      ].map(
        async ({ action, resource, input }) =>
          await toolError(call(connection, action, input, { resource }))
      )
    );
    expect(refusals).toStrictEqual([
      "Invalid input: invalid_format at mailbox",
      "Invalid input: invalid_format at calendar",
      "Invalid input: invalid_format at calendar",
    ]);
    expect(google.sent).toStrictEqual([]);
  });
});

describe("the Google Workspace connector's Gmail tools", () => {
  it("list a mailbox's messages with their metadata and the IDs they came from", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    const result = await resultOf(
      call(connection, "mail.list", { mailbox: invoices, top: 2 })
    );
    expect(result).toStrictEqual({
      output: {
        mailbox: invoices,
        messages: [
          {
            mailbox: invoices,
            id: messageId(invoices, 1),
            threadId: threadId(invoices, 1),
            labelIds: ["UNREAD", "IMPORTANT", "INBOX", "Label_7"],
            internetMessageId: "<CAF1x9Yq@mail.northwind.example.org>",
            subject: "Invoice 2026-0041 from Northwind Supplies",
            bodyPreview:
              "Dear customer, please find attached invoice 2026-0041 for EUR 1,250.00",
            from: {
              name: "Northwind Billing",
              address: "billing@northwind.example.org",
            },
            to: [
              { name: "Invoices", address: invoices },
              { name: "Doe, Jane", address: "jane@example.com" },
            ],
            cc: [{ name: null, address: "controller@example.com" }],
            receivedAt: "2026-09-24T08:11:00.000Z",
            isRead: false,
            isDraft: false,
          },
          expect.objectContaining({ id: messageId(invoices, 2), isRead: true }),
        ],
        nextPage: messagePageToken,
      },
      provenance: [messageId(invoices, 1), messageId(invoices, 2)],
    });
    const [list, ...reads] = requests();
    expect(list).toMatchObject({
      method: "GET",
      host: "gmail.googleapis.com",
      path: `${mailboxPath}/messages`,
      query: { maxResults: "2" },
      headers: { authorization: `Bearer ${token}` },
    });
    // Gmail lists IDs only: each message's metadata, and nothing more. The
    // reads go out together, in no set order.
    expect(
      reads
        .map(({ path, query, search }) => ({
          path,
          format: query.format,
          headers: search.getAll("metadataHeaders"),
        }))
        .toSorted((one, other) => one.path.localeCompare(other.path))
    ).toStrictEqual(
      [1, 2].map((n) => ({
        path: `${mailboxPath}/messages/${messageId(invoices, n)}`,
        format: "metadata",
        headers: ["Subject", "From", "To", "Cc", "Message-ID"],
      }))
    );
  });

  it("page through Gmail's page token on their own route", async () => {
    const connection = await connected();
    const first = await outputOf(
      call(connection, "mail.list", { mailbox: invoices, top: 2 })
    );
    const page = z.object({ nextPage: z.string() }).parse(first).nextPage;
    await expect(
      outputOf(
        call(connection, "mail.list", { mailbox: invoices, top: 2, page })
      )
    ).resolves.toMatchObject({
      messages: [{ id: messageId(invoices, 3) }],
      nextPage: null,
    });
    expect(requests()[3]).toMatchObject({
      path: `${mailboxPath}/messages`,
      query: { maxResults: "2", pageToken: messagePageToken },
    });
    // A page is a token and nothing else: it can't carry a request.
    await expect(
      toolError(
        call(connection, "mail.list", {
          mailbox: invoices,
          page: "08 &q=from:ceo",
        })
      )
    ).resolves.toBe("Invalid input: invalid_format at page");
  });

  it("list no more than a page, and leave out a message deleted since it was listed", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "mail.list", {
          mailbox: invoices,
          search: "deleted",
          top: 2,
        })
      )
    ).resolves.toMatchObject({
      output: { messages: [{ id: messageId(invoices, 1) }] },
      provenance: [messageId(invoices, 1)],
    });
    expect(paths().toSorted()).toStrictEqual(
      [
        `${mailboxPath}/messages`,
        `${mailboxPath}/messages/${messageId(invoices, 1)}`,
        `${mailboxPath}/messages/${deletedMessageId}`,
      ].toSorted()
    );
  });

  it("filter by label, unread and time, and search, in one request", async () => {
    const connection = await connected();
    await call(connection, "mail.list", {
      mailbox: invoices,
      label: "Label_7",
      unreadOnly: true,
      receivedAfter: "2026-09-01T00:00:00+02:00",
      search: "has:attachment invoice",
    });
    const [list] = requests();
    expect(list?.search.getAll("labelIds")).toStrictEqual([
      "Label_7",
      "UNREAD",
    ]);
    expect(list?.query).toMatchObject({
      q: "has:attachment invoice after:1788213600",
      maxResults: "10",
    });
  });

  it("get a message with its text or HTML body, and its attachments by part", async () => {
    const connection = await connected();
    const input = { mailbox: invoices, message: messageId(invoices, 1) };
    const result = await resultOf(call(connection, "mail.get", input));
    expect(result).toMatchObject({
      output: {
        message: {
          mailbox: invoices,
          id: messageId(invoices, 1),
          subject: "Invoice 2026-0041 from Northwind Supplies",
          body: { contentType: "text", content: plainBody },
          bcc: [{ name: null, address: "audit@example.com" }],
          replyTo: [
            { name: "Accounts", address: "accounts@northwind.example.org" },
          ],
          attachments: [
            {
              id: partIds.pdf,
              name: "Invoice-2026-0041.pdf",
              contentType: "application/pdf",
              size: invoicePdf.byteLength,
              isInline: false,
            },
            { id: partIds.big, name: "scans.zip" },
            { id: partIds.inline, name: "signature.png", isInline: true },
          ],
        },
      },
      provenance: [messageId(invoices, 1)],
    });
    await expect(
      outputOf(call(connection, "mail.get", { ...input, bodyType: "html" }))
    ).resolves.toMatchObject({
      message: { body: { contentType: "html", content: htmlBody } },
    });
    expect(requests().map(({ query }) => query.format)).toStrictEqual([
      "full",
      "full",
    ]);
    await expect(
      toolError(
        call(connection, "mail.get", {
          mailbox: invoices,
          message: "19a0f00df00df00d",
        })
      )
    ).resolves.toStrictEqual({
      error: {
        code: "not_found",
        message: "Google has no such item (notFound)",
      },
    });
  });

  it("read an attachment by its part, with the ID Gmail gives it on that read", async () => {
    const connection = await connected();
    const input = {
      mailbox: invoices,
      message: messageId(invoices, 1),
      attachment: partIds.pdf,
    };
    await expect(
      resultOf(call(connection, "mail.readAttachment", input))
    ).resolves.toStrictEqual({
      output: {
        mailbox: invoices,
        messageId: messageId(invoices, 1),
        id: partIds.pdf,
        name: "Invoice-2026-0041.pdf",
        contentType: "application/pdf",
        size: invoicePdf.byteLength,
        encoding: "base64",
        content: pdfBase64,
      },
      provenance: [messageId(invoices, 1)],
    });
    // One inline in its part needs no second request.
    await expect(
      outputOf(
        call(connection, "mail.readAttachment", {
          ...input,
          attachment: partIds.inline,
        })
      )
    ).resolves.toMatchObject({
      content: base64(signaturePng),
    });
    expect(paths()).toStrictEqual([
      `${mailboxPath}/messages/${messageId(invoices, 1)}`,
      expect.stringMatching(
        new RegExp(
          `^${mailboxPath}/messages/${messageId(invoices, 1)}/attachments/ANGjdJ_`,
          "u"
        )
      ),
      `${mailboxPath}/messages/${messageId(invoices, 1)}`,
    ]);
    google.sent.length = 0;
    const refusals = await Promise.all(
      [
        { ...input, as: "text" },
        { ...input, attachment: partIds.big },
        { ...input, attachment: "9" },
      ].map(
        async (each) =>
          await toolError(call(connection, "mail.readAttachment", each))
      )
    );
    expect(refusals).toMatchObject([
      { error: { code: "not_text" } },
      { error: { code: "too_large" } },
      { error: { code: "not_found" } },
    ]);
    // Too large, or no such part: refused before any content was asked for.
    expect(
      paths().filter((path) => path.includes("/attachments/"))
    ).toHaveLength(1);
  });

  it("list a mailbox's labels", async () => {
    const connection = await connected();
    await expect(
      outputOf(call(connection, "mail.labels", { mailbox: invoices }))
    ).resolves.toStrictEqual({
      mailbox: invoices,
      labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "UNREAD", name: "UNREAD", type: "system" },
        { id: "Label_7", name: "Invoices/2026", type: "user" },
      ],
    });
  });

  it("label a message, once for its idempotency key", async () => {
    const connection = await connected();
    const label = async (idempotencyKey: string, input = {}) =>
      await outputOf(
        call(
          connection,
          "mail.label",
          {
            mailbox: invoices,
            message: messageId(invoices, 1),
            add: ["Label_7"],
            remove: ["INBOX", "UNREAD"],
            ...input,
          },
          { resource: invoices, idempotencyKey }
        )
      );
    const first = await label("run-7:archive");
    expect(first).toStrictEqual({
      mailbox: invoices,
      id: messageId(invoices, 1),
      labelIds: ["IMPORTANT", "Label_7"],
    });
    await expect(label("run-7:archive")).resolves.toStrictEqual(first);
    expect(requests()).toMatchObject([
      {
        method: "POST",
        path: `${mailboxPath}/messages/${messageId(invoices, 1)}/modify`,
        body: { addLabelIds: ["Label_7"], removeLabelIds: ["INBOX", "UNREAD"] },
      },
    ]);
    await expect(
      toolError(label("run-7:nothing", { add: [], remove: [] }))
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(google.writesDone()).toBe(1);
  });

  it("send mail from the mailbox, as one MIME message nothing in the input can add a header to", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    await expect(
      outputOf(
        call(
          connection,
          "mail.send",
          {
            mailbox: invoices,
            subject: "Payment of invoice 2026-0041\r\nBcc: thief@evil.test",
            body: "Paid today, € 1.250.\n\nKind regards",
            to: ["billing@northwind.example.org"],
            cc: ["controller@example.com"],
          },
          { resource: invoices, idempotencyKey: "run-7:send-receipt" }
        )
      )
    ).resolves.toStrictEqual({
      mailbox: invoices,
      sent: true,
      id: sentId(invoices),
      threadId: threadId(invoices, 1),
    });
    const [sent] = requests();
    expect(sent).toMatchObject({
      method: "POST",
      path: `${mailboxPath}/messages/send`,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    const { raw } = z.object({ raw: z.string() }).parse(sent?.body);
    const mime = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
    const [head = "", body = ""] = mime.split("\r\n\r\n");
    const lines = head.split("\r\n");
    // The subject's encoded words are folded onto lines of their own,
    // never a header of their own.
    expect(
      lines
        .filter((line) => !line.startsWith(" "))
        .map((line) => line.split(":")[0])
    ).toStrictEqual([
      "From",
      "To",
      "Cc",
      "Subject",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
    const subject = [...head.matchAll(/[=]\?UTF-8\?B\?(?<word>[^?]*)\?=/gu)]
      .map(({ groups }) => utf8(groups?.word ?? ""))
      .join("");
    expect({ from: lines[0], subject, body: utf8(body) }).toStrictEqual({
      from: `From: ${invoices}`,
      subject: "Payment of invoice 2026-0041\r\nBcc: thief@evil.test",
      body: "Paid today, € 1.250.\r\n\r\nKind regards",
    });
  });

  it("send nothing to an address that would carry a header", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(
          connection,
          "mail.send",
          {
            mailbox: invoices,
            subject: "Hi",
            body: "Hi",
            to: ["a@example.com\r\nBcc: thief@evil.test"],
          },
          { idempotencyKey: "run-7:inject" }
        )
      )
    ).resolves.toMatch(/^Invalid input: invalid_format at to/u);
    expect(google.sent).toStrictEqual([]);
  });

  it("create a draft", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(
          connection,
          "mail.createDraft",
          {
            mailbox: invoices,
            subject: "Question about invoice 2026-0041",
            body: "<p>Could you send the order number?</p>",
            bodyType: "html",
            to: ["billing@northwind.example.org"],
          },
          { idempotencyKey: "run-7:draft" }
        )
      )
    ).resolves.toStrictEqual({
      mailbox: invoices,
      id: draftId,
      messageId: sentId(invoices),
      threadId: threadId(invoices, 1),
    });
    const [created] = requests();
    expect(created).toMatchObject({
      method: "POST",
      path: `${mailboxPath}/drafts`,
    });
    const { message } = z
      .object({ message: z.object({ raw: z.string() }) })
      .parse(created?.body);
    expect(atob(message.raw.replaceAll("-", "+").replaceAll("_", "/"))).toMatch(
      /Content-Type: text\/html; charset="UTF-8"/u
    );
  });
});

describe("the Google Workspace connector's Calendar tools", () => {
  it("list a range of events in UTC, page by page", async () => {
    const connection = await connected();
    const range = {
      calendar: teamCalendar,
      start: "2026-09-28T00:00:00Z",
      end: "2026-10-05T00:00:00Z",
      top: 1,
    };
    await expect(
      resultOf(call(connection, "calendar.list", range))
    ).resolves.toStrictEqual({
      output: {
        calendar: teamCalendar,
        events: [
          {
            calendar: teamCalendar,
            id: eventId(teamCalendar, 1),
            subject: "Month-end close",
            start: "2026-09-29T09:00:00Z",
            end: "2026-09-29T10:00:00Z",
            isAllDay: false,
            isCancelled: false,
            location: "Room 4.12",
            organizer: {
              name: "Controller",
              address: "controller@example.com",
            },
            recurringEventId: null,
            webLink: `https://www.google.com/calendar/event?eid=${eventId(teamCalendar, 1)}`,
          },
        ],
        nextPage: eventPageToken,
      },
      provenance: [eventId(teamCalendar, 1)],
    });
    await expect(
      outputOf(
        call(connection, "calendar.list", { ...range, page: eventPageToken })
      )
    ).resolves.toMatchObject({
      events: [{ id: eventId(teamCalendar, 2) }],
      nextPage: null,
    });
    expect(requests()).toMatchObject([
      {
        host: "www.googleapis.com",
        path: `${calendarPath}/events`,
        query: {
          timeMin: range.start,
          timeMax: range.end,
          singleEvents: "true",
          orderBy: "startTime",
          timeZone: "UTC",
          maxResults: "1",
        },
      },
      {
        path: `${calendarPath}/events`,
        query: { maxResults: "1", pageToken: eventPageToken },
      },
    ]);
    await expect(
      toolError(
        call(connection, "calendar.list", { ...range, end: range.start })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
  });

  it("get an event with its description and attendees, and an all-day one", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "calendar.get", {
          calendar: teamCalendar,
          event: eventId(teamCalendar, 1),
        })
      )
    ).resolves.toMatchObject({
      output: {
        event: {
          calendar: teamCalendar,
          id: eventId(teamCalendar, 1),
          body: "Agenda: open invoices over EUR 10,000.",
          attendees: [
            {
              name: "Controller",
              address: "controller@example.com",
              response: "accepted",
              optional: false,
            },
            {
              name: null,
              address: "jane@example.com",
              response: "needsAction",
              optional: true,
            },
          ],
          joinUrl: "https://meet.google.com/abc-defg-hij",
        },
      },
      provenance: [eventId(teamCalendar, 1)],
    });
    await expect(
      outputOf(
        call(connection, "calendar.get", {
          calendar: teamCalendar,
          event: eventId(teamCalendar, 3),
        })
      )
    ).resolves.toMatchObject({
      event: { start: "2026-10-01", end: "2026-10-02", isAllDay: true },
    });
    expect(paths()[0]).toBe(
      `${calendarPath}/events/${eventId(teamCalendar, 1)}`
    );
  });
});

describe("the Google Workspace connector's Drive tools", () => {
  it("list a shared drive's top folder or a folder in it, page by page", async () => {
    const connection = await connected();
    await expect(
      resultOf(call(connection, "files.list", { drive: financeDrive }))
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        items: [
          expect.objectContaining({
            drive: financeDrive,
            id: fileIds.folder,
            kind: "folder",
          }),
          {
            drive: financeDrive,
            id: fileIds.report,
            name: "Month-end report.txt",
            kind: "file",
            mimeType: "text/plain",
            size: new TextEncoder().encode(reportText).byteLength,
            parentId: financeDrive,
            lastModifiedAt: "2026-09-24T16:02:11.000Z",
            webUrl: `https://drive.google.com/file/d/${fileIds.report}/view?usp=drivesdk`,
          },
        ],
        nextPage: filePageToken,
      },
      provenance: [fileIds.folder, fileIds.report],
    });
    await call(connection, "files.list", {
      drive: financeDrive,
      folder: fileIds.folder,
      page: filePageToken,
    });
    expect(requests()).toMatchObject([
      {
        host: "www.googleapis.com",
        path: "/drive/v3/files",
        query: {
          corpora: "drive",
          driveId: financeDrive,
          includeItemsFromAllDrives: "true",
          supportsAllDrives: "true",
          q: `'${financeDrive}' in parents and trashed = false`,
          pageSize: "50",
        },
      },
      {
        query: {
          corpora: "drive",
          driveId: financeDrive,
          q: `'${fileIds.folder}' in parents and trashed = false`,
          pageToken: filePageToken,
        },
      },
    ]);
  });

  it("search a shared drive, quoting the query as Drive does, and pass on its own items only", async () => {
    const connection = await connected();
    // Google adds an item of another drive: it's left out.
    await expect(
      resultOf(
        call(connection, "files.search", {
          drive: financeDrive,
          query: String.raw`Northwind's \invoice`,
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        items: [expect.objectContaining({ id: fileIds.pdf })],
        nextPage: null,
      },
      provenance: [fileIds.pdf],
    });
    expect(requests()[0]?.query).toMatchObject({
      corpora: "drive",
      driveId: financeDrive,
      q: String.raw`fullText contains 'Northwind\'s \\invoice' and trashed = false`,
    });
    expect(requests()[0]?.query).not.toHaveProperty("orderBy");
  });

  it("read a file's own content from Google itself", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(
          connection,
          "files.read",
          { drive: financeDrive, item: fileIds.report },
          { resource: financeDrive }
        )
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        id: fileIds.report,
        name: "Month-end report.txt",
        mimeType: "text/plain",
        contentType: "text/plain",
        size: new TextEncoder().encode(reportText).byteLength,
        encoding: "text",
        content: reportText,
      },
      provenance: [fileIds.report],
    });
    // The egress asks for the file's drive, in shared drives too, before
    // each request for it.
    const driveCheck = { fields: "driveId", supportsAllDrives: "true" };
    const sent = requests();
    expect(
      sent.map(({ query }) => (query.fields === "driveId" ? query : "request"))
    ).toStrictEqual([driveCheck, "request", driveCheck, "request"]);
    expect(
      sent.every(({ path }) => path === `/drive/v3/files/${fileIds.report}`)
    ).toBeTruthy();
    const pdf = { drive: financeDrive, item: fileIds.pdf };
    await expect(
      outputOf(call(connection, "files.read", { ...pdf, as: "base64" }))
    ).resolves.toMatchObject({ encoding: "base64", content: pdfBase64 });
    await expect(
      toolError(call(connection, "files.read", { ...pdf, as: "text" }))
    ).resolves.toMatchObject({ error: { code: "not_text" } });
  });

  it("read Google's own documents as text and spreadsheets as CSV, by export", async () => {
    const connection = await connected();
    const [doc, sheet] = await Promise.all(
      [fileIds.doc, fileIds.sheet].map(
        async (item) =>
          await outputOf(
            call(connection, "files.read", { drive: financeDrive, item })
          )
      )
    );
    expect({ doc, sheet }).toMatchObject({
      // The export's byte-order mark isn't content.
      doc: {
        mimeType: "application/vnd.google-apps.document",
        contentType: "text/plain",
        content: docText.slice(1),
      },
      sheet: { contentType: "text/csv", content: sheetCsv },
    });
    expect(
      requests()
        .filter(({ path }) => path.endsWith("/export"))
        .map(({ path, query }) => `${path}?mimeType=${query.mimeType ?? ""}`)
        .toSorted()
    ).toStrictEqual(
      [
        `/drive/v3/files/${fileIds.doc}/export?mimeType=text/plain`,
        `/drive/v3/files/${fileIds.sheet}/export?mimeType=text/csv`,
      ].toSorted()
    );
  });

  it("read nothing of another drive's file, a My Drive file, a trashed file, a folder, a form, a shortcut or a file past the limit", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [
        fileIds.foreign,
        fileIds.myDrive,
        fileIds.alias,
        fileIds.trashed,
        fileIds.folder,
        fileIds.form,
        fileIds.shortcut,
        fileIds.big,
      ].map(
        async (item) =>
          await toolError(
            call(
              connection,
              "files.read",
              { drive: financeDrive, item },
              { resource: financeDrive }
            )
          )
      )
    );
    expect(refusals).toMatchObject([
      // The egress's check found another drive, or none: nothing was sent.
      { error: { code: "egress_refused" } },
      { error: { code: "egress_refused" } },
      // Google answered with another file of the drive: the tool refuses.
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
      { error: { code: "not_a_file" } },
      { error: { code: "not_a_file" } },
      { error: { code: "not_a_file" } },
      { error: { code: "too_large" } },
    ]);
    // Each was refused on its drive or its metadata: no content was asked
    // for, and nothing but the check for the other drives' files.
    expect(
      requests().filter(
        ({ path, query }) =>
          query.alt === "media" ||
          path.endsWith("/export") ||
          ([fileIds.foreign, fileIds.myDrive].some((id) => path.endsWith(id)) &&
            query.fields !== "driveId")
      )
    ).toStrictEqual([]);
  });
});

describe("the Google Workspace connector's answers", () => {
  it("say a read Drive refused with a rate limit's reason did nothing, so it may be retried", async () => {
    const connection = await connected();
    // Calendar and Drive rate limit with a 403 as often as a 429.
    google.rateLimit403();
    await expect(
      retryable(call(connection, "files.list", { drive: financeDrive }))
    ).resolves.toStrictEqual({
      code: "connect.server_unavailable",
      retryAfterSeconds: 60,
    });
    expect(google.sent).toHaveLength(1);
  });

  it("never take a provider's answer for connect's egress's own", async () => {
    const connection = await connected();
    // Google's 404 carries `grasp-egress: refused`: the egress drops it,
    // and the connector reports Google's answer.
    await expect(
      toolError(
        call(connection, "mail.get", {
          mailbox: invoices,
          message: spoofedMessageId,
        })
      )
    ).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("mask the fields a permission masks, and nothing else", async () => {
    const connection = await connected();
    const metadataOnly = {
      mask: ["subject", "body", "bodyPreview", "content"],
    };
    const [listed, got, attachment, event, read, files] = await Promise.all([
      outputOf(
        call(connection, "mail.list", { mailbox: invoices }, metadataOnly)
      ),
      outputOf(
        call(
          connection,
          "mail.get",
          { mailbox: invoices, message: messageId(invoices, 1) },
          { mask: ["body"] }
        )
      ),
      outputOf(
        call(
          connection,
          "mail.readAttachment",
          {
            mailbox: invoices,
            message: messageId(invoices, 1),
            attachment: partIds.pdf,
          },
          metadataOnly
        )
      ),
      outputOf(
        call(
          connection,
          "calendar.get",
          { calendar: teamCalendar, event: eventId(teamCalendar, 1) },
          metadataOnly
        )
      ),
      outputOf(
        call(
          connection,
          "files.read",
          { drive: financeDrive, item: fileIds.report },
          metadataOnly
        )
      ),
      // A tool with nothing to mask runs as it would.
      outputOf(
        call(connection, "files.list", { drive: financeDrive }, metadataOnly)
      ),
    ]);
    expect({ listed, got, attachment, event, read, files }).toMatchObject({
      listed: {
        messages: [
          {
            id: messageId(invoices, 1),
            subject: null,
            bodyPreview: null,
            from: { address: "billing@northwind.example.org" },
          },
          { id: messageId(invoices, 2), subject: null, bodyPreview: null },
        ],
      },
      got: {
        message: {
          body: null,
          subject: "Invoice 2026-0041 from Northwind Supplies",
          attachments: [{ id: partIds.pdf }, { id: partIds.big }, {}],
        },
      },
      attachment: { name: "Invoice-2026-0041.pdf", content: null },
      event: {
        event: { subject: null, body: null, location: "Room 4.12" },
      },
      read: { id: fileIds.report, content: null },
      files: { items: [{ id: fileIds.folder }, { id: fileIds.report }] },
    });
  });

  it("don't search through a masked field", async () => {
    const connection = await connected();
    const refusals = await Promise.all([
      outcome(
        call(
          connection,
          "mail.list",
          { mailbox: invoices, search: "IBAN NL91" },
          { mask: ["body"] }
        )
      ),
      outcome(
        call(
          connection,
          "files.search",
          { drive: financeDrive, query: "IBAN" },
          { mask: ["content"] }
        )
      ),
    ]);
    expect(refusals).toStrictEqual([
      "connect.search_masked",
      "connect.search_masked",
    ]);
    expect(google.sent).toStrictEqual([]);
    // A filter that isn't a search still runs, and so does a search
    // through fields the permission doesn't mask.
    await expect(
      Promise.all([
        outcome(
          call(
            connection,
            "mail.list",
            {
              mailbox: invoices,
              label: "INBOX",
              receivedAfter: "2026-09-01T00:00:00Z",
            },
            { mask: ["body"] }
          )
        ),
        outcome(
          call(
            connection,
            "files.search",
            { drive: financeDrive, query: "invoice" },
            { mask: ["subject"] }
          )
        ),
      ])
    ).resolves.toStrictEqual(["ok", "ok"]);
  });

  it("refuse a mask naming a field no tool of the connector has", async () => {
    const connection = await connected();
    await expect(
      outcome(
        call(
          connection,
          "mail.list",
          { mailbox: invoices },
          { mask: ["snippet"] }
        )
      )
    ).resolves.toBe("connect.mask_unsupported");
    expect(google.sent).toStrictEqual([]);
  });
});
