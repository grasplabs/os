import { segmentValuePattern } from "@grasp-os/connector-kit/manifest";
import { z } from "zod";

import { SourceError, readFromProvider } from "./event-kinds.ts";
import type { EventKind, ReadEvents, SourceRead } from "./event-kinds.ts";

// Microsoft 365's events, read from Microsoft Graph with the connection's
// token, which stays in connect: Graph's delta queries say what changed in
// a mailbox's inbox or a drive since the last read, from the link the last
// read handed back. Nothing but graph.microsoft.com is ever sent the token:
// a link Graph hands back is followed only on that host.
//
// A source is the resource a permission names (a mailbox, a drive) or,
// for a permission on the whole connection, the account's own mailbox or
// OneDrive (`''`), reached by its Entra object ID.

const graphHost = "graph.microsoft.com";
const v1 = `https://${graphHost}/v1.0`;

/** A mailbox, as the connector's mail tools take it: an address or user ID. */
const isMailbox = (resource: string): boolean =>
  resource.length <= 256 && segmentValuePattern.test(resource);

/** A drive, as the connector's file tools take it: `b!...`. */
const isDrive = (resource: string): boolean =>
  resource.length <= 256 && /^b![\w=!.-]+$/u.test(resource);

/** The user a source of the account's own reaches: its Entra object ID. */
const ownUser = ({ connection }: SourceRead): string => {
  if (connection.accountId === null) {
    throw new SourceError("The connection names no account");
  }
  return encodeURIComponent(connection.accountId);
};

/**
 * A query string as OData reads it: each value percent-encoded, a space
 * as `%20` (never `+`, which OData may take as a plus).
 */
const queryOf = (query: Readonly<Record<string, string>>): string =>
  Object.entries(query)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("&");

const pageOf = <Item extends z.ZodType>(item: Item) =>
  z.object({
    value: z.array(item),
    "@odata.nextLink": z.string().optional(),
    "@odata.deltaLink": z.string().optional(),
  });

/** Graph, sent the token: only on its own host, over HTTPS. */
const graph = readFromProvider({
  name: "Microsoft Graph",
  hosts: [graphHost],
  // Graph's pages hold up to this many items: a read takes a few pages.
  headers: { prefer: "odata.maxpagesize=50" },
});

/** Graph's page, as one read of a delta query goes through them. */
const graphPage =
  <Item extends z.ZodType>(item: Item) =>
  async (token: string, url: string) => {
    const page = pageOf(item).parse(await graph(token, url));
    return {
      items: page.value,
      next: page["@odata.nextLink"],
      end: page["@odata.deltaLink"],
    };
  };

const address = z
  .object({
    emailAddress: z
      .object({
        name: z.string().nullish(),
        address: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish();

const message = z.object({
  id: z.string(),
  "@removed": z.unknown().optional(),
  receivedDateTime: z.string().nullish(),
  subject: z.string().nullish(),
  from: address,
  hasAttachments: z.boolean().nullish(),
  conversationId: z.string().nullish(),
  internetMessageId: z.string().nullish(),
  webLink: z.string().nullish(),
});

const messageFields = [
  "id",
  "receivedDateTime",
  "subject",
  "from",
  "hasAttachments",
  "conversationId",
  "internetMessageId",
  "webLink",
].join(",");

/** At or after `since`, by an ISO timestamp Graph wrote; false without one. */
const isSince = (at: string | null | undefined, since: Date): boolean => {
  if (at === null || at === undefined) {
    return false;
  }
  const time = Date.parse(at);
  return Number.isFinite(time) && time >= since.getTime();
};

/**
 * `m365.mail.received`: mail that arrived in the mailbox's inbox after the
 * source started. A message a delta read shows again (read, flagged) has
 * the same ID, so core starts nothing for it twice.
 */
const mailReceived: EventKind = {
  provider: "microsoft",
  server: "microsoft-365",
  action: "mail.list",
  isResource: isMailbox,
  read: async (read): Promise<ReadEvents> => {
    const { source } = read;
    const mailbox =
      source.resource === ""
        ? ownUser(read)
        : encodeURIComponent(source.resource);
    const since = source.createdAt.toISOString();
    const start = `${v1}/users/${mailbox}/mailFolders/inbox/messages/delta?${queryOf(
      {
        $select: messageFields,
        $filter: `receivedDateTime ge ${since}`,
      }
    )}`;
    const { items, cursor, more } = await read.pages(
      graphPage(message),
      source.cursor ?? start
    );
    const events = items.flatMap((item) =>
      item["@removed"] === undefined &&
      isSince(item.receivedDateTime, source.createdAt)
        ? [
            {
              id: item.id,
              payload: {
                mailbox:
                  source.resource === ""
                    ? (read.connection.accountId ?? "")
                    : source.resource,
                id: item.id,
                folder: "inbox",
                subject: item.subject ?? null,
                from:
                  item.from?.emailAddress === null ||
                  item.from?.emailAddress === undefined
                    ? null
                    : {
                        name: item.from.emailAddress.name ?? null,
                        address: item.from.emailAddress.address ?? null,
                      },
                receivedAt: item.receivedDateTime ?? null,
                hasAttachments: item.hasAttachments ?? false,
                conversationId: item.conversationId ?? null,
                internetMessageId: item.internetMessageId ?? null,
                webLink: item.webLink ?? null,
              },
            },
          ]
        : []
    );
    return { events, cursor, more };
  },
};

const driveItem = z.object({
  id: z.string(),
  name: z.string().nullish(),
  file: z.object({ mimeType: z.string().nullish() }).nullish(),
  deleted: z.unknown().optional(),
  createdDateTime: z.string().nullish(),
  size: z.number().nullish(),
  webUrl: z.string().nullish(),
  parentReference: z
    .object({ driveId: z.string().nullish(), id: z.string().nullish() })
    .nullish(),
});

const driveItemFields = [
  "id",
  "name",
  "file",
  "deleted",
  "createdDateTime",
  "size",
  "webUrl",
  "parentReference",
].join(",");

/**
 * `m365.file.created`: files created in the drive after the source
 * started, in any folder of it. Graph's first read of a drive starts from
 * now (`token=latest`), so what the drive already holds is never read.
 */
const fileCreated: EventKind = {
  provider: "microsoft",
  server: "microsoft-365",
  action: "files.list",
  isResource: isDrive,
  read: async (read): Promise<ReadEvents> => {
    const { source } = read;
    const drive =
      source.resource === ""
        ? `users/${ownUser(read)}/drive`
        : `drives/${encodeURIComponent(source.resource)}`;
    const start = `${v1}/${drive}/root/delta?${queryOf({
      token: "latest",
      $select: driveItemFields,
    })}`;
    const { items, cursor, more } = await read.pages(
      graphPage(driveItem),
      source.cursor ?? start
    );
    const events = items.flatMap((item) =>
      item.deleted === undefined &&
      item.file !== null &&
      item.file !== undefined &&
      isSince(item.createdDateTime, source.createdAt)
        ? [
            {
              id: item.id,
              payload: {
                drive:
                  item.parentReference?.driveId ??
                  (source.resource === "" ? null : source.resource),
                id: item.id,
                name: item.name ?? null,
                mimeType: item.file.mimeType ?? null,
                size: item.size ?? null,
                folderId: item.parentReference?.id ?? null,
                createdAt: item.createdDateTime ?? null,
                webUrl: item.webUrl ?? null,
              },
            },
          ]
        : []
    );
    return { events, cursor, more };
  },
};

/** Microsoft 365's event types. */
export const microsoftEventKinds: Readonly<Record<string, EventKind>> = {
  "m365.mail.received": mailReceived,
  "m365.file.created": fileCreated,
};
