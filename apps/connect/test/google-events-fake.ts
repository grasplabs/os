/**
 * Gmail's history and Drive's changes, as connect's event sources read
 * them: each mailbox's history (records of messages added, one or more
 * each) and each shared drive's changes, in the order they came, served
 * in the shapes Google's APIs document. A history ID or page token is a
 * position in that order. A test adds mail
 * and changes, deletes a message, or has Gmail forget old history.
 */

type Item = Record<string, unknown>;

/** Where a mailbox's history IDs start. */
const historyBase = 1_804_000;

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { status });

const notFound = (): Response =>
  json(
    { error: { code: 404, message: "Requested entity was not found." } },
    404
  );

export const googleEventsFake = () => {
  const mailboxes = new Map<string, { records: Item[][]; forgotten: number }>();
  const drives = new Map<string, Item[]>();
  const deleted = new Set<string>();
  const mailboxOf = (address: string) => {
    let mailbox = mailboxes.get(address);
    if (mailbox === undefined) {
      mailbox = { records: [], forgotten: 0 };
      mailboxes.set(address, mailbox);
    }
    return mailbox;
  };
  const changesOf = (drive: string): Item[] => {
    let changes = drives.get(drive);
    if (changes === undefined) {
      changes = [];
      drives.set(drive, changes);
    }
    return changes;
  };
  const gmail = (path: string, url: URL): Response => {
    const found = /^\/gmail\/v1\/users\/(?<address>[^/]+)\/(?<rest>.+)$/u.exec(
      path
    )?.groups;
    if (found?.address === undefined || found.rest === undefined) {
      return notFound();
    }
    const mailbox = mailboxOf(found.address);
    const now = String(historyBase + mailbox.records.length);
    const messages = mailbox.records.flat();
    if (found.rest === "profile") {
      return json({
        emailAddress: found.address,
        messagesTotal: messages.length,
        threadsTotal: messages.length,
        historyId: now,
      });
    }
    if (found.rest === "history") {
      const from =
        Number(
          url.searchParams.get("pageToken") ??
            url.searchParams.get("startHistoryId")
        ) - historyBase;
      if (from < mailbox.forgotten) {
        return notFound();
      }
      const size = Number(url.searchParams.get("maxResults") ?? "100");
      const page = mailbox.records.slice(from, from + size);
      const to = from + page.length;
      return json({
        history: page.map((record, index) => ({
          id: String(historyBase + from + index + 1),
          messages: record.map(({ id, threadId }) => ({ id, threadId })),
          messagesAdded: record.map(({ id, threadId, labelIds }) => ({
            message: { id, threadId, labelIds },
          })),
        })),
        ...(to < mailbox.records.length
          ? { nextPageToken: String(historyBase + to) }
          : {}),
        historyId: now,
      });
    }
    const id = /^messages\/(?<id>[^/]+)$/u.exec(found.rest)?.groups?.id;
    const message = messages.find((each) => each.id === id);
    return message === undefined || deleted.has(String(id))
      ? notFound()
      : json(message);
  };
  const drive = (path: string, url: URL): Response => {
    const driveId = url.searchParams.get("driveId") ?? "";
    const changes = changesOf(driveId);
    if (path === "/drive/v3/changes/startPageToken") {
      return json({
        kind: "drive#startPageToken",
        startPageToken: String(changes.length),
      });
    }
    if (path !== "/drive/v3/changes") {
      return notFound();
    }
    const from = Number(url.searchParams.get("pageToken"));
    const size = Number(url.searchParams.get("pageSize") ?? "100");
    const page = changes.slice(from, from + size);
    const to = from + page.length;
    return json({
      kind: "drive#changeList",
      changes: page,
      ...(to < changes.length
        ? { nextPageToken: String(to) }
        : { newStartPageToken: String(to) }),
    });
  };
  return {
    /** Google's answer; 404 for anything else. */
    answer: (request: Request, url: URL): Response => {
      if (request.method !== "GET") {
        return notFound();
      }
      const path = decodeURIComponent(url.pathname);
      if (url.hostname === "gmail.googleapis.com") {
        return gmail(path, url);
      }
      return url.hostname === "www.googleapis.com"
        ? drive(path, url)
        : notFound();
    },
    /** Messages added to `address`'s mailbox, in one history record. */
    receive: (address: string, ...messages: Item[]): void => {
      mailboxOf(address).records.push(messages);
    },
    /** A message deleted for good. */
    remove: (id: string): void => {
      deleted.add(id);
    },
    /** Gmail no longer keeps `address`'s history so far. */
    forget: (address: string): void => {
      const mailbox = mailboxOf(address);
      mailbox.forgotten = mailbox.records.length;
    },
    /** A change in shared drive `drive`. */
    change: (driveId: string, change: Item): void => {
      changesOf(driveId).push(change);
    },
  };
};

export type GoogleEventsFake = ReturnType<typeof googleEventsFake>;
