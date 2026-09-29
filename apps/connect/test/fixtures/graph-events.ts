/**
 * What Microsoft Graph's delta queries answer about new mail and files, as
 * recorded from its v1.0 API with the names, addresses and IDs made up:
 * a message in an inbox, one removed from it, and a drive's new file, a
 * new folder and a deleted item, each with the fields connect selects.
 */
import { messageId } from "./graph.ts";

/** A supplier's invoice arriving in `mailbox`'s inbox at `receivedAt`. */
export const invoiceMail = (
  mailbox: string,
  n: number,
  receivedAt: string
) => ({
  "@odata.etag": `W/"CQAAABYAAABmtXf2uSv0SqAGJ5k6N7QDAAAKmT${n}"`,
  id: messageId(mailbox, n),
  receivedDateTime: receivedAt,
  subject: `Invoice INV-${n}`,
  from: {
    emailAddress: {
      name: "Northwind Billing",
      address: "billing@northwind.example.com",
    },
  },
  hasAttachments: true,
  conversationId:
    "AAQkAGE1M2IyNGNmLTI5MTktNDUyZi1iOTVjLTc2ZjI5ZmNmZmQ2MwAQAKnRWlxgjPpKqB9J2uGz8Uk=",
  internetMessageId: `<inv-${n}@northwind.example.com>`,
  webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(messageId(mailbox, n))}&exvsurl=1&viewmodel=ReadMessageItem`,
});

/** A message delta's entry for one that left the inbox. */
export const removedMail = (mailbox: string, n: number) => ({
  "@odata.type": "#microsoft.graph.message",
  id: messageId(mailbox, n),
  "@removed": { reason: "deleted" },
});

/** A drive item's ID, as Graph shapes them. */
export const itemId = (n: number): string =>
  `01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD${String(n).padStart(3, "0")}`;

/** The drive's root folder. */
const rootId = "01BYE5RZ56Y2GOVW7725BZO354PWSELRRZ";

/** A file created in `drive` at `createdAt`. */
export const createdFile = (drive: string, n: number, createdAt: string) => ({
  "@odata.type": "#microsoft.graph.driveItem",
  id: itemId(n),
  name: `Invoice INV-${n}.pdf`,
  createdDateTime: createdAt,
  lastModifiedDateTime: createdAt,
  size: 48_213,
  webUrl: `https://example.sharepoint.com/sites/finance/Shared%20Documents/Invoice%20INV-${n}.pdf`,
  file: {
    mimeType: "application/pdf",
    hashes: { quickXorHash: "e8ZaL3hW0v5d0mD3QnPjwq8yF1s=" },
  },
  parentReference: {
    driveId: drive,
    driveType: "documentLibrary",
    id: rootId,
    path: "/drive/root:",
  },
});

/** A folder created in `drive`: not a file. */
export const createdFolder = (drive: string, n: number, createdAt: string) => ({
  "@odata.type": "#microsoft.graph.driveItem",
  id: itemId(n),
  name: "Invoices 2026",
  createdDateTime: createdAt,
  lastModifiedDateTime: createdAt,
  size: 0,
  webUrl:
    "https://example.sharepoint.com/sites/finance/Shared%20Documents/Invoices%202026",
  folder: { childCount: 0 },
  parentReference: { driveId: drive, id: rootId, path: "/drive/root:" },
});

/** A delta's entry for an item deleted from `drive`. */
export const deletedItem = (drive: string, n: number) => ({
  "@odata.type": "#microsoft.graph.driveItem",
  id: itemId(n),
  deleted: { state: "deleted" },
  file: {},
  parentReference: { driveId: drive, id: rootId },
});
