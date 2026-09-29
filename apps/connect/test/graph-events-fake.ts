/**
 * Microsoft Graph's delta queries, as connect's event sources read them:
 * a mailbox's inbox and a drive, each a list of what arrived in order,
 * served in the shapes Graph's v1.0 reference documents (`@odata.context`,
 * `@odata.nextLink` and `@odata.deltaLink`, a delta link naming the inbox
 * its own way). A test adds mail and files, then reads what connect asked
 * for.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (core's test/connect-providers.ts embeds its source), connect's call it
 * straight from a fetch spy.
 */
export const graphEventsFake = () => {
  const graph = "https://graph.microsoft.com/v1.0";
  /** Each mailbox's inbox, and each drive's items, in the order they came. */
  const inboxes = new Map<string, Record<string, unknown>[]>();
  const drives = new Map<string, Record<string, unknown>[]>();
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const listOf = (
    lists: Map<string, Record<string, unknown>[]>,
    key: string
  ): Record<string, unknown>[] => {
    let list = lists.get(key);
    if (list === undefined) {
      list = [];
      lists.set(key, list);
    }
    return list;
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const pageSizeOf = (request: Request): number => {
    const size = /odata\.maxpagesize=(?<size>\d+)/u.exec(
      request.headers.get("prefer") ?? ""
    )?.groups?.size;
    return size === undefined ? 10 : Number(size);
  };
  /** One page of `list` from `from`, and the link to go on from. */
  const page = (
    request: Request,
    context: string,
    list: Record<string, unknown>[],
    from: number,
    link: (query: string) => string
  ): Response => {
    const value = list.slice(from, from + pageSizeOf(request));
    const to = from + value.length;
    return Response.json({
      "@odata.context": context,
      value,
      ...(to < list.length
        ? { "@odata.nextLink": link(`$skiptoken=${to}`) }
        : { "@odata.deltaLink": link(`$deltatoken=${to}`) }),
    });
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const positionOf = (url: URL): number | undefined => {
    const position =
      url.searchParams.get("$skiptoken") ??
      url.searchParams.get("$deltatoken") ??
      url.searchParams.get("token");
    return position === null || position === "latest"
      ? undefined
      : Number(position);
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const notFound = (): Response =>
    Response.json(
      { error: { code: "ResourceNotFound", message: "Not found" } },
      { status: 404 }
    );
  /** The first read of an inbox: from the time its filter names. */
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const firstSince = (list: Record<string, unknown>[], url: URL): number => {
    const since = /receivedDateTime ge (?<since>\S+)/u.exec(
      url.searchParams.get("$filter") ?? ""
    )?.groups?.since;
    const time = since === undefined ? 0 : Date.parse(since);
    const first = list.findIndex(
      (item) => Date.parse(String(item.receivedDateTime)) >= time
    );
    return first === -1 ? list.length : first;
  };
  const mailPath =
    /^\/v1\.0\/users\/(?<mailbox>[^/]+)\/mailFolders(?:\/inbox|\('inbox'\))\/messages\/delta$/u;
  const drivePath =
    /^\/v1\.0\/(?:users\/(?<user>[^/]+)\/drive|drives\/(?<drive>[^/]+))\/root\/delta$/u;

  return {
    /** Graph's answer to a delta query; 404 for anything else. */
    answer: (request: Request, url: URL): Response => {
      const path = decodeURIComponent(url.pathname);
      const mailbox = mailPath.exec(path)?.groups?.mailbox;
      if (request.method === "GET" && mailbox !== undefined) {
        const list = listOf(inboxes, mailbox.toLowerCase());
        return page(
          request,
          `${graph}/$metadata#Collection(message)`,
          list,
          positionOf(url) ?? firstSince(list, url),
          (query) =>
            `${graph}/users/${encodeURIComponent(mailbox)}/mailFolders('inbox')/messages/delta?${query}`
        );
      }
      const { user, drive } = drivePath.exec(path)?.groups ?? {};
      if (
        request.method === "GET" &&
        (user !== undefined || drive !== undefined)
      ) {
        const base =
          user === undefined ? `drives/${drive}` : `users/${user}/drive`;
        const list = listOf(
          drives,
          user === undefined ? `${drive}` : `user:${user}`
        );
        return page(
          request,
          `${graph}/$metadata#Collection(driveItem)`,
          list,
          // `token=latest` starts from now.
          positionOf(url) ?? list.length,
          (query) =>
            `${graph}/${base}/root/delta?${query.replace("$deltatoken", "token")}`
        );
      }
      return notFound();
    },
    /** A message arriving in `mailbox`'s inbox, or shown again as changed. */
    receive: (mailbox: string, message: Record<string, unknown>): void => {
      listOf(inboxes, mailbox.toLowerCase()).push(message);
    },
    /** An item created or changed in `drive` (`user:<id>` for a OneDrive). */
    change: (drive: string, item: Record<string, unknown>): void => {
      listOf(drives, drive).push(item);
    },
  };
};

/** What the fake holds, for a test to change. */
export type GraphEventsFake = ReturnType<typeof graphEventsFake>;
