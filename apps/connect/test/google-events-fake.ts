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

/** How far apart the history IDs of consecutive records are. */
const historyStep = 7;

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
    // History IDs aren't consecutive: record n (from 1) is `historyBase +
    // n * historyStep`, and only IDs Gmail issued are taken.
    const idOf = (records: number): string =>
      String(historyBase + records * historyStep);
    const now = idOf(mailbox.records.length);
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
      const token = url.searchParams.get("pageToken");
      const after =
        (Number(url.searchParams.get("startHistoryId")) - historyBase) /
        historyStep;
      // A page token is a position; a history ID must be one issued.
      const from = token === null ? after : Number(token.slice(1));
      if (
        !Number.isInteger(from) ||
        from > mailbox.records.length ||
        from < mailbox.forgotten
      ) {
        return notFound();
      }
      const size = Number(url.searchParams.get("maxResults") ?? "100");
      const page = mailbox.records.slice(from, from + size);
      const to = from + page.length;
      return json({
        history: page.map((record, index) => ({
          id: idOf(from + index + 1),
          messages: record.map(({ id, threadId }) => ({ id, threadId })),
          messagesAdded: record.map(({ id, threadId, labelIds }) => ({
            message: { id, threadId, labelIds },
          })),
        })),
        ...(to < mailbox.records.length ? { nextPageToken: `p${to}` } : {}),
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
  /**
   * Gmail's batch endpoint: each part a request of its own, answered as
   * Gmail answers it, in one multipart answer.
   */
  const batch = async (request: Request): Promise<Response> => {
    const type = request.headers.get("content-type") ?? "";
    const boundary = type.split("boundary=")[1]?.trim() ?? "";
    const text = await request.text();
    const parts = text
      .split(`--${boundary}`)
      .slice(1)
      .filter((part) => !part.startsWith("--"));
    const answers = await Promise.all(
      parts.map(async (part, index) => {
        const line = part.split("\r\n").find((each) => each.startsWith("GET "));
        const target = new URL(
          `https://gmail.googleapis.com${line?.split(" ")[1] ?? "/"}`
        );
        const answer = gmail(decodeURIComponent(target.pathname), target);
        const status =
          answer.status === 200 ? "200 OK" : `${answer.status} Not Found`;
        return `--batch_answer\r\nContent-Type: application/http\r\nContent-ID: <response-m${index}>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${await answer.text()}\r\n`;
      })
    );
    return new Response(`${answers.join("")}--batch_answer--`, {
      headers: { "content-type": "multipart/mixed; boundary=batch_answer" },
    });
  };
  return {
    /** Google's answer; 404 for anything else. */
    answer: async (request: Request, url: URL): Promise<Response> => {
      if (
        request.method === "POST" &&
        url.hostname === "gmail.googleapis.com" &&
        url.pathname === "/batch/gmail/v1"
      ) {
        return await batch(request);
      }
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
