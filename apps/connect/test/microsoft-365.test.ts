import { connectorManifestSchema } from "@grasp-os/connector-kit/manifest";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeConnector } from "../src/connectors.ts";
import { accessTokenFor } from "../src/tokens.ts";
import { connectAccount, outcome, ownAccount, someone } from "./connect.ts";
import {
  archiveFolderId,
  attachmentsSkipToken,
  endlessAttachments,
  foreignFolderId,
  bigAttachmentId,
  childrenSkipToken,
  ceo,
  financeDrive,
  invoicePdf,
  invoices,
  itemAttachmentId,
  itemIds,
  messageId,
  movedId,
  eventId,
  pdfAttachmentId,
  pdfBase64,
  personalDrive,
  reportText,
  spoofedId,
} from "./fixtures/graph.ts";
import { fakeGraph } from "./graph-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import {
  callTool as call,
  outputOf,
  parsedRequests,
  refusalsFor,
  resultOf,
  toolError,
} from "./tool-calls.ts";
import type { Connection, Input } from "./tool-calls.ts";

// The Microsoft 365 connector against Graph's recorded answers, through
// connect's real call path: capability, policy, a fresh isolate, the
// egress (which adds the token and holds each call to its routes), and
// back. Scoping comes first: a call for one mailbox or drive reaches only
// that one, by construction.

const providers = fakeProviders();
const graph = fakeGraph();

/** Someone's Microsoft 365 connection, made through OAuth. */
const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  return { id, person };
};

/** What left connect, each request with its query and JSON body parsed. */
const requests = () => parsedRequests(graph.sent);

/** Graph's requests' paths. */
const graphPaths = (): string[] =>
  requests()
    .filter(({ host }) => host === "graph.microsoft.com")
    .map(({ path }) => path);

const mailboxPath = `/v1.0/users/${encodeURIComponent(invoices)}`;
const drivePath = `/v1.0/drives/${financeDrive}`;

const manifest = connectorManifestSchema.parse(
  nativeConnector("microsoft-365")?.manifest
);

/** Input for each mail and calendar tool, but its mailbox. */
const mailboxInputs: Record<string, Input> = {
  "mail.list": {},
  "mail.get": { message: messageId(ceo, 1) },
  "mail.readAttachment": {
    message: messageId(ceo, 1),
    attachment: pdfAttachmentId,
  },
  "mail.move": { message: messageId(ceo, 1), destination: "archive" },
  "mail.send": { subject: "Hi", body: "Hi", to: ["a@example.com"] },
  "mail.createDraft": { subject: "Hi", body: "Hi", to: ["a@example.com"] },
  "calendar.list": {
    start: "2026-09-28T00:00:00Z",
    end: "2026-10-05T00:00:00Z",
  },
  "calendar.get": { event: eventId(ceo, 1) },
};

/** Input for each file tool, but its drive. */
const driveInputs: Record<string, Input> = {
  "files.list": {},
  "files.search": { query: "invoice" },
  "files.read": { item: itemIds.report },
};

describe("the Microsoft 365 connector's scoping", () => {
  it("binds every route of every tool to its mailbox or drive, never /me", () => {
    const unbound = Object.entries(manifest.actions).flatMap(
      ([name, { resource, routes }]) =>
        routes
          .filter(
            ({ path }) =>
              !(
                (resource === "mailbox" &&
                  path.startsWith("/v1.0/users/{mailbox}/")) ||
                (resource === "drive" &&
                  path.startsWith("/v1.0/drives/{drive}/"))
              )
          )
          .map(({ path }) => `${name} ${path}`)
    );
    expect(unbound).toStrictEqual([]);
    expect(
      Object.keys(manifest.actions).toSorted(),
      "every tool is tested for scoping below"
    ).toStrictEqual(
      [...Object.keys(mailboxInputs), ...Object.keys(driveInputs)].toSorted()
    );
    expect(manifest.hosts).toStrictEqual(["graph.microsoft.com"]);
  });

  it("keeps a call for one mailbox out of every other, for every mail and calendar tool", async () => {
    const connection = await connected();
    // The capability is for invoices@; each call names ceo@, or a spelling
    // Graph would take for invoices@ but that isn't exactly it.
    await expect(
      refusalsFor(connection, mailboxInputs, "mailbox", invoices, [
        ceo,
        "Invoices@example.com",
        `${invoices} `,
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(graph.sent).toStrictEqual([]);
    // The same capability reads its own mailbox, and only its paths.
    await call(
      connection,
      "mail.list",
      { mailbox: invoices },
      { resource: invoices }
    );
    expect(graphPaths()).toStrictEqual([`${mailboxPath}/messages`]);
  });

  it("keeps a call for one drive out of every other", async () => {
    const connection = await connected();
    await expect(
      refusalsFor(connection, driveInputs, "drive", financeDrive, [
        personalDrive,
      ])
    ).resolves.toStrictEqual(new Set(["connect.resource_out_of_scope"]));
    expect(graph.sent).toStrictEqual([]);
  });
});

describe("the Microsoft 365 connector's mail tools", () => {
  it("list a mailbox's messages, newest first, with the IDs they came from", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    const result = await resultOf(
      call(connection, "mail.list", { mailbox: invoices })
    );
    expect(result).toMatchObject({
      output: {
        mailbox: invoices,
        messages: [
          {
            mailbox: invoices,
            id: messageId(invoices, 1),
            subject: "Invoice 2026-0041 from Northwind Supplies",
            from: {
              name: "Northwind Billing",
              address: "billing@northwind.example.org",
            },
            to: [{ name: "Invoices", address: invoices }],
            isRead: false,
            hasAttachments: true,
          },
          { mailbox: invoices, id: messageId(invoices, 2) },
        ],
      },
      provenance: [messageId(invoices, 1), messageId(invoices, 2)],
    });
    expect(requests()).toMatchObject([
      {
        method: "GET",
        path: `${mailboxPath}/messages`,
        query: { $top: "25", $orderby: "receivedDateTime desc" },
        headers: { authorization: `Bearer ${token}` },
      },
    ]);
  });

  it("page through Graph's next link on their own route, never following it", async () => {
    const connection = await connected();
    const first = await outputOf(
      call(connection, "mail.list", { mailbox: invoices, top: 2 })
    );
    expect(first).toMatchObject({ nextPage: "%24skip=2" });
    const page = z.object({ nextPage: z.string() }).parse(first).nextPage;
    await expect(
      outputOf(
        call(connection, "mail.list", { mailbox: invoices, top: 2, page })
      )
    ).resolves.toMatchObject({
      messages: [{ id: messageId(invoices, 3) }],
      nextPage: null,
    });
    // Graph's link names `users('invoices%40example.com')`: not followed.
    expect(requests()[1]).toMatchObject({
      path: `${mailboxPath}/messages`,
      query: { $top: "2", $skip: "2" },
    });
    // A page is only a position: anything else in one is ignored, and one
    // without a position is refused.
    await call(connection, "mail.list", {
      mailbox: invoices,
      page: "%24skip=2&%24select=body",
    });
    expect(requests()[2]?.query.$select).not.toBe("body");
    await expect(
      toolError(
        call(connection, "mail.list", {
          mailbox: invoices,
          page: "$select=body",
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
  });

  it("search a folder, filter, but not both at once", async () => {
    const connection = await connected();
    await call(connection, "mail.list", {
      mailbox: invoices,
      folder: "inbox",
      search: "invoice 2026",
    });
    await call(connection, "mail.list", {
      mailbox: invoices,
      unreadOnly: true,
    });
    const [searched, filtered] = requests();
    expect({ searched, filtered }).toMatchObject({
      searched: {
        path: `${mailboxPath}/mailFolders/inbox/messages`,
        query: { $search: '"invoice 2026"' },
      },
      filtered: {
        query: {
          $filter:
            "receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false",
          $orderby: "receivedDateTime desc",
        },
      },
    });
    // Search results come by relevance: no order is asked for.
    expect(searched?.query).not.toHaveProperty("$orderby");
    await expect(
      toolError(
        call(connection, "mail.list", {
          mailbox: invoices,
          search: "invoice",
          unreadOnly: true,
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(graph.sent).toHaveLength(2);
  });

  it("get a message with its body as text, and its attachments' metadata", async () => {
    const connection = await connected();
    const result = await resultOf(
      call(connection, "mail.get", {
        mailbox: invoices,
        message: messageId(invoices, 1),
      })
    );
    expect(result).toMatchObject({
      output: {
        message: {
          mailbox: invoices,
          id: messageId(invoices, 1),
          body: {
            contentType: "text",
            content:
              "Dear customer,\r\n\r\nPlease find attached invoice 2026-0041 for EUR 1,250.00.\r\n",
          },
          attachments: [
            {
              id: pdfAttachmentId,
              name: "Invoice-2026-0041.pdf",
              contentType: "application/pdf",
              size: invoicePdf.byteLength,
              kind: "file",
            },
            { id: itemAttachmentId, kind: "item" },
          ],
          moreAttachments: false,
        },
      },
      provenance: [messageId(invoices, 1)],
    });
    // Attachments are listed without their content, every page on the
    // tool's own route: Graph's next link, naming the user and message its
    // own way, is never followed.
    const attachmentsPath = `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, 1))}/attachments`;
    const [got, first, second, ...rest] = requests();
    expect({ got, first, second, rest }).toMatchObject({
      got: { headers: { prefer: 'outlook.body-content-type="text"' } },
      first: { path: attachmentsPath },
      second: { path: attachmentsPath },
      rest: [],
    });
    expect([first?.query, second?.query]).toStrictEqual([
      { $select: "id,name,contentType,size,isInline" },
      {
        $select: "id,name,contentType,size,isInline",
        $skiptoken: attachmentsSkipToken,
      },
    ]);
    await expect(
      toolError(
        call(connection, "mail.get", {
          mailbox: invoices,
          message: "AAMkUnknown=",
        })
      )
    ).resolves.toStrictEqual({
      error: {
        code: "not_found",
        message: "Microsoft 365 has no such item (ErrorItemNotFound)",
      },
    });
  });

  it("list a message's attachments up to a bound, and say there are more", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        call(connection, "mail.get", {
          mailbox: invoices,
          message: messageId(invoices, endlessAttachments),
        })
      )
    ).resolves.toMatchObject({ message: { moreAttachments: true } });
    expect(
      graphPaths().filter((path) => path.endsWith("/attachments"))
    ).toHaveLength(10);
  });

  it("read a file attachment as base64, and only a file", async () => {
    const connection = await connected();
    const input = {
      mailbox: invoices,
      message: messageId(invoices, 1),
      attachment: pdfAttachmentId,
    };
    await expect(
      resultOf(call(connection, "mail.readAttachment", input))
    ).resolves.toStrictEqual({
      output: {
        mailbox: invoices,
        messageId: messageId(invoices, 1),
        id: pdfAttachmentId,
        name: "Invoice-2026-0041.pdf",
        contentType: "application/pdf",
        size: invoicePdf.byteLength,
        encoding: "base64",
        content: pdfBase64,
      },
      provenance: [messageId(invoices, 1)],
    });
    const refusals = await Promise.all(
      [
        { ...input, as: "text" },
        { ...input, attachment: itemAttachmentId },
        { ...input, attachment: bigAttachmentId },
      ].map(
        async (each) =>
          await toolError(call(connection, "mail.readAttachment", each))
      )
    );
    expect(refusals).toMatchObject([
      { error: { code: "not_text" } },
      { error: { code: "not_a_file" } },
      { error: { code: "too_large" } },
    ]);
    // Too large: refused on its size, before its content was fetched.
    const big = requests().filter(({ path }) =>
      path.endsWith(encodeURIComponent(bigAttachmentId))
    );
    expect(big).toMatchObject([
      { query: { $select: "id,name,contentType,size,isInline" } },
    ]);
  });

  it("move a message once for its idempotency key, to a folder of its own mailbox", async () => {
    const connection = await connected();
    const move = async (destination: string, idempotencyKey: string) =>
      await outputOf(
        call(
          connection,
          "mail.move",
          { mailbox: invoices, message: messageId(invoices, 1), destination },
          { resource: invoices, idempotencyKey }
        )
      );
    const first = await move("archive", "run-7:move-invoice");
    expect(first).toStrictEqual({
      mailbox: invoices,
      previousId: messageId(invoices, 1),
      id: movedId(invoices, 1),
      folderId: archiveFolderId,
    });
    await expect(move("archive", "run-7:move-invoice")).resolves.toStrictEqual(
      first
    );
    // The destination is looked up in the bound mailbox, and the message
    // moved to the folder it names there.
    expect(requests()).toMatchObject([
      { method: "GET", path: `${mailboxPath}/mailFolders/archive` },
      {
        method: "POST",
        path: `${mailboxPath}/messages/${encodeURIComponent(messageId(invoices, 1))}/move`,
        body: { destinationId: archiveFolderId },
      },
    ]);
    // Another mailbox's folder isn't one of this mailbox's: nothing moves.
    await expect(
      toolError(move(foreignFolderId, "run-7:move-away"))
    ).resolves.toMatchObject({ error: { code: "not_found" } });
    expect(requests().filter(({ method }) => method === "POST")).toHaveLength(
      1
    );
  });

  it("send mail from a shared mailbox", async () => {
    const connection = await connected();
    const token = await accessTokenFor(env, connection.id);
    await expect(
      outputOf(
        call(
          connection,
          "mail.send",
          {
            mailbox: invoices,
            subject: "Payment of invoice 2026-0041",
            body: "Paid today.",
            to: ["billing@northwind.example.org"],
            cc: ["controller@example.com"],
          },
          { resource: invoices, idempotencyKey: "run-7:send-receipt" }
        )
      )
    ).resolves.toStrictEqual({ mailbox: invoices, sent: true });
    expect(requests()).toMatchObject([
      {
        method: "POST",
        path: `${mailboxPath}/sendMail`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: {
          message: {
            subject: "Payment of invoice 2026-0041",
            body: { contentType: "text", content: "Paid today." },
            toRecipients: [
              { emailAddress: { address: "billing@northwind.example.org" } },
            ],
            ccRecipients: [
              { emailAddress: { address: "controller@example.com" } },
            ],
            bccRecipients: [],
            replyTo: [],
          },
          saveToSentItems: true,
        },
      },
    ]);
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
    ).resolves.toMatchObject({ mailbox: invoices, id: messageId(invoices, 9) });
    expect(requests()).toMatchObject([
      {
        method: "POST",
        path: `${mailboxPath}/messages`,
        body: {
          subject: "Question about invoice 2026-0041",
          body: { contentType: "html" },
        },
      },
    ]);
  });
});

describe("the Microsoft 365 connector's calendar tools", () => {
  it("list a range of events in UTC, page by page", async () => {
    const connection = await connected();
    const range = {
      mailbox: invoices,
      start: "2026-09-28T00:00:00Z",
      end: "2026-10-05T00:00:00Z",
      top: 1,
    };
    const skipToken = "d2c7f1a0-5b9e-4d1c-8e6a-3f2b7c9d0e1f";
    const first = await resultOf(call(connection, "calendar.list", range));
    expect(first).toMatchObject({
      output: {
        mailbox: invoices,
        events: [
          {
            mailbox: invoices,
            id: eventId(invoices, 1),
            subject: "Month-end close",
            start: { dateTime: "2026-09-29T09:00:00.0000000", timeZone: "UTC" },
            location: "Room 4.12",
          },
        ],
        nextPage: `%24skiptoken=${skipToken}`,
      },
      provenance: [eventId(invoices, 1)],
    });
    await expect(
      outputOf(
        call(connection, "calendar.list", {
          ...range,
          page: `%24skiptoken=${skipToken}`,
        })
      )
    ).resolves.toMatchObject({
      events: [{ id: eventId(invoices, 2) }],
      nextPage: null,
    });
    expect(requests()).toMatchObject([
      {
        path: `${mailboxPath}/calendarView`,
        query: { startDateTime: range.start, endDateTime: range.end },
        headers: { prefer: 'outlook.timezone="UTC"' },
      },
      { path: `${mailboxPath}/calendarView`, query: { $skiptoken: skipToken } },
    ]);
    await expect(
      toolError(
        call(connection, "calendar.list", { ...range, end: range.start })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
  });

  it("get an event with its body and attendees", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "calendar.get", {
          mailbox: invoices,
          event: eventId(invoices, 1),
        })
      )
    ).resolves.toMatchObject({
      output: {
        event: {
          mailbox: invoices,
          id: eventId(invoices, 1),
          body: { contentType: "text" },
          attendees: [
            {
              name: "Controller",
              address: "controller@example.com",
              type: "required",
              response: "accepted",
            },
          ],
        },
      },
      provenance: [eventId(invoices, 1)],
    });
    expect(graphPaths()).toStrictEqual([
      `${mailboxPath}/events/${encodeURIComponent(eventId(invoices, 1))}`,
    ]);
  });
});

describe("the Microsoft 365 connector's file tools", () => {
  it("list a drive's top folder or a folder in it, page by page", async () => {
    const connection = await connected();
    const first = await resultOf(
      call(connection, "files.list", { drive: financeDrive })
    );
    expect(first).toMatchObject({
      output: {
        drive: financeDrive,
        items: [
          { drive: financeDrive, id: itemIds.folder, kind: "folder" },
          {
            drive: financeDrive,
            id: itemIds.report,
            kind: "file",
            mimeType: "text/plain",
          },
        ],
        nextPage: `%24skiptoken=${childrenSkipToken}`,
      },
      provenance: [itemIds.folder, itemIds.report],
    });
    await call(connection, "files.list", {
      drive: financeDrive,
      folder: itemIds.folder,
      page: `%24skiptoken=${childrenSkipToken}`,
    });
    expect(requests()).toMatchObject([
      { path: `${drivePath}/root/children` },
      {
        path: `${drivePath}/items/${itemIds.folder}/children`,
        query: { $skiptoken: childrenSkipToken },
      },
    ]);
  });

  it("search a drive, quoting the query as OData does, and pass on its own items only", async () => {
    const connection = await connected();
    // Graph finds an item shared from another drive too: it's left out.
    await expect(
      resultOf(
        call(connection, "files.search", {
          drive: financeDrive,
          query: "Northwind's invoice",
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        items: [expect.objectContaining({ id: itemIds.pdf })],
        nextPage: null,
      },
      provenance: [itemIds.pdf],
    });
    expect(graph.sent[0]?.path).toMatch(
      new RegExp(
        String.raw`^${drivePath}/root/search\(q='Northwind''s%20invoice'\)\?`,
        "u"
      )
    );
    // A query the egress would refuse in a path is refused before it.
    await expect(
      toolError(
        call(connection, "files.search", {
          drive: financeDrive,
          query: "../../me",
        })
      )
    ).resolves.toBe("Invalid input: invalid_format at query");
    expect(graph.sent).toHaveLength(1);
  });

  it("read a file through SharePoint's download, without the token going there", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "files.read", {
          drive: financeDrive,
          item: itemIds.report,
        })
      )
    ).resolves.toStrictEqual({
      output: {
        drive: financeDrive,
        id: itemIds.report,
        name: "Month-end report.txt",
        mimeType: "text/plain",
        size: new TextEncoder().encode(reportText).byteLength,
        encoding: "text",
        content: reportText,
      },
      provenance: [itemIds.report],
    });
    expect(requests()).toMatchObject([
      {
        host: "graph.microsoft.com",
        path: `${drivePath}/items/${itemIds.report}`,
      },
      {
        host: "graph.microsoft.com",
        path: `${drivePath}/items/${itemIds.report}/content`,
      },
      {
        host: graph.sharePointHost,
        path: "/sites/Finance/_layouts/15/download.aspx",
        query: { UniqueId: itemIds.report },
      },
    ]);
    expect(graph.sent[2]?.headers).not.toHaveProperty("authorization");
    const pdf = { drive: financeDrive, item: itemIds.pdf };
    await expect(
      outputOf(call(connection, "files.read", { ...pdf, as: "base64" }))
    ).resolves.toMatchObject({ encoding: "base64", content: pdfBase64 });
    await expect(
      toolError(call(connection, "files.read", { ...pdf, as: "text" }))
    ).resolves.toMatchObject({ error: { code: "not_text" } });
  });

  it("read no folder, no other drive's file, and no file past the size limit", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [itemIds.folder, itemIds.foreign, itemIds.big, itemIds.controls].map(
        async (item) =>
          await toolError(
            call(connection, "files.read", { drive: financeDrive, item })
          )
      )
    );
    // A text file whose escaped content would pass the answer's limit is
    // refused once read; the others before their content is asked for.
    expect(refusals).toMatchObject([
      { error: { code: "not_a_file" } },
      { error: { code: "not_found" } },
      { error: { code: "too_large" } },
      { error: { code: "too_large" } },
    ]);
    expect(
      graphPaths().filter((path) => path.endsWith("/content"))
    ).toStrictEqual([`${drivePath}/items/${itemIds.controls}/content`]);
  });

  it("follow a download's redirect only to SharePoint over HTTPS, once", async () => {
    const connection = await connected();
    const outcomes = await Promise.all(
      [itemIds.elsewhere, itemIds.plain, itemIds.nested, itemIds.twice].map(
        async (item) =>
          await toolError(
            call(connection, "files.read", { drive: financeDrive, item })
          )
      )
    );
    // The egress withholds each answer, and says so.
    expect(outcomes).toMatchObject(
      Array.from({ length: 4 }, () => ({ error: { code: "egress_failed" } }))
    );
    // Only the one redirect to SharePoint itself was followed; its own
    // redirect was not.
    expect(
      graph.sent
        .map(({ host }) => host)
        .filter((host) => host !== "graph.microsoft.com")
    ).toStrictEqual([graph.sharePointHost]);
  });
});

describe("the Microsoft 365 connector's answers", () => {
  it("free a move's key when its folder lookup is throttled, so a retry moves once", async () => {
    const connection = await connected();
    const move = async () =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: invoices,
            message: messageId(invoices, 1),
            destination: "archive",
          },
          { idempotencyKey: "run-8:move-lookup" }
        )
      );
    // The first request, the lookup, is throttled: nothing is moved.
    graph.throttle();
    const outcomes = [await move(), await move(), await move()];
    expect(outcomes).toStrictEqual(["connect.server_unavailable", "ok", "ok"]);
    expect(graph.writesDone()).toBe(1);
  });

  it("never take a provider's answer for connect's egress's own", async () => {
    const connection = await connected();
    // Graph's 404 carries `grasp-egress: refused`: the egress drops it,
    // and the connector reports Graph's answer.
    await expect(
      toolError(
        call(connection, "mail.get", { mailbox: invoices, message: spoofedId })
      )
    ).resolves.toMatchObject({ error: { code: "not_found" } });
  });

  it("free a throttled move's key after its folder lookup, a read", async () => {
    const connection = await connected();
    const move = async () =>
      await outcome(
        call(
          connection,
          "mail.move",
          {
            mailbox: invoices,
            message: messageId(invoices, 1),
            destination: "archive",
          },
          { idempotencyKey: "run-8:move" }
        )
      );
    graph.throttleWrite();
    const outcomes = [await move(), await move(), await move()];
    expect(outcomes).toStrictEqual(["connect.server_unavailable", "ok", "ok"]);
    expect(graph.writesDone()).toBe(1);
  });

  it("tell a request connect's egress refused from one Graph refused", async () => {
    const connection = await connected();
    // `..` is a Graph ID's alphabet, but a dot segment in a path: the
    // request that goes out isn't one of the tool's routes.
    await expect(
      toolError(
        call(connection, "mail.get", { mailbox: invoices, message: ".." })
      )
    ).resolves.toMatchObject({ error: { code: "egress_refused" } });
    expect(graph.sent).toStrictEqual([]);
  });

  it("mask the fields a permission masks, and nothing else", async () => {
    const connection = await connected();
    const metadataOnly = {
      mask: ["subject", "body", "bodyPreview", "content"],
    };
    const [listed, got, read, files] = await Promise.all([
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
          "files.read",
          { drive: financeDrive, item: itemIds.report },
          metadataOnly
        )
      ),
      // A tool with nothing to mask runs as it would.
      outputOf(
        call(connection, "files.list", { drive: financeDrive }, metadataOnly)
      ),
    ]);
    expect({ listed, got, read, files }).toMatchObject({
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
          attachments: [{ id: pdfAttachmentId }, { id: itemAttachmentId }],
        },
      },
      read: { id: itemIds.report, content: null },
      files: { items: [{ id: itemIds.folder }, { id: itemIds.report }] },
    });
  });

  it("run a search under a mask, with the masked fields of what it finds null", async () => {
    const connection = await connected();
    const metadataOnly = {
      mask: ["subject", "body", "bodyPreview", "content"],
    };
    // Which items match can say something of what a masked field holds:
    // accepted (threat model CN17). What they hold stays masked.
    const [mail, files] = await Promise.all([
      outputOf(
        call(
          connection,
          "mail.list",
          { mailbox: invoices, search: "invoice 2026" },
          metadataOnly
        )
      ),
      outputOf(
        call(
          connection,
          "files.search",
          { drive: financeDrive, query: "invoice" },
          metadataOnly
        )
      ),
    ]);
    expect({ mail, files }).toMatchObject({
      mail: {
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
      // A file search's items have nothing maskable: they come as they are.
      files: { items: [{ id: itemIds.pdf }] },
    });
    // The search went to Graph as asked.
    expect(
      requests().some(({ query }) => query.$search === '"invoice 2026"')
    ).toBeTruthy();
  });

  it("refuse a mask naming a field no tool of the connector has", async () => {
    const connection = await connected();
    await expect(
      outcome(
        call(
          connection,
          "mail.list",
          { mailbox: invoices },
          { mask: ["bodyText"] }
        )
      )
    ).resolves.toBe("connect.mask_unsupported");
    expect(graph.sent).toStrictEqual([]);
  });
});
