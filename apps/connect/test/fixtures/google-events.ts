/**
 * What Gmail's and Drive's APIs answer about new mail and files, as
 * recorded from them with the names, addresses and IDs made up: a
 * message's metadata (the headers connect asks for), and a shared drive's
 * changes: a new file, a new folder, a trashed file, one of another drive.
 */

/** A Gmail message ID, as Gmail shapes them. */
export const gmailId = (n: number): string =>
  `19a2f${String(n).padStart(11, "0")}`;

/** A supplier's invoice reaching the inbox at `receivedAt` (ms). */
export const gmailInvoice = (n: number, receivedAt: number) => ({
  id: gmailId(n),
  threadId: gmailId(n),
  labelIds: ["UNREAD", "CATEGORY_UPDATES", "INBOX"],
  snippet: `Please find attached invoice INV-${n}.`,
  sizeEstimate: 48_213,
  historyId: String(1_804_000 + n),
  internalDate: String(receivedAt),
  payload: {
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [
      {
        name: "From",
        value: '"Northwind Billing" <billing@northwind.example.com>',
      },
      { name: "Subject", value: `Invoice INV-${n}` },
    ],
  },
});

/** A message the mailbox's owner sent: added, but not to the inbox. */
export const gmailSent = (n: number, sentAt: number) => ({
  ...gmailInvoice(n, sentAt),
  labelIds: ["SENT"],
});

/** A Drive file ID, as Drive shapes them. */
export const driveFileId = (n: number): string =>
  `1Bxi${String(n).padStart(6, "0")}MvRlZq9GkTn2WcYp8`;

/** A file created in shared drive `drive` at `createdAt`. */
export const driveFile = (drive: string, n: number, createdAt: string) => ({
  kind: "drive#change",
  changeType: "file",
  removed: false,
  fileId: driveFileId(n),
  file: {
    id: driveFileId(n),
    name: `Invoice INV-${n}.pdf`,
    mimeType: "application/pdf",
    size: "48213",
    createdTime: createdAt,
    parents: [drive],
    driveId: drive,
    trashed: false,
    webViewLink: `https://drive.google.com/file/d/${driveFileId(n)}/view?usp=drivesdk`,
  },
});

/** A folder created in `drive`: not a file. */
export const driveFolder = (drive: string, n: number, createdAt: string) => ({
  ...driveFile(drive, n, createdAt),
  file: {
    ...driveFile(drive, n, createdAt).file,
    name: "Invoices 2026",
    mimeType: "application/vnd.google-apps.folder",
    size: undefined,
  },
});

/** A file of `drive` moved to the trash. */
export const driveTrashed = (drive: string, n: number, createdAt: string) => ({
  ...driveFile(drive, n, createdAt),
  file: { ...driveFile(drive, n, createdAt).file, trashed: true },
});
