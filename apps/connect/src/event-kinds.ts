import type { Json } from "@grasp-os/shared/json";

import type { Connection } from "./connections.ts";
import type { eventSources } from "./db/schema.ts";

// What an event type is to connect (events.ts), and how its sources are
// read from a provider: the types each provider's events module
// (graph-events.ts, google-events.ts) implements.

/** A source's row. */
export type EventSource = typeof eventSources.$inferSelect;

/** What one read of a source has to go on. */
export interface SourceRead {
  source: EventSource;
  connection: Connection;
  /** The connection's access token, for the provider's own hosts only. */
  token: string;
  /**
   * Goes through a provider's pages from `start`, each fetched with the
   * connection's token by `page`, until the provider says it's at the end
   * (`end`, a link to read on from next time) or it has `readMaxItems`
   * (`next`, a link to the rest), at most a page more. The items read, and
   * where to go on.
   */
  pages: <Item>(
    page: (
      token: string,
      url: string
    ) => Promise<{ items: Item[]; next?: string; end?: string }>,
    start: string
  ) => Promise<{ items: Item[]; cursor: string; more: boolean }>;
}

/** One event a read found: the provider's ID of the item, and its payload. */
export interface ReadEvent {
  id: string;
  payload: Json;
}

/** What one read of a source found, and where the next goes on from. */
export interface ReadEvents {
  events: ReadEvent[];
  cursor: string;
  /** Whether there is more to read already: the next read is due at once. */
  more: boolean;
}

/** One type of event, and how its sources are read. */
export interface EventKind {
  /** The provider and native connector whose connections report it. */
  provider: string;
  server: string;
  /** Whether a permission's resource is one of this type's sources. */
  isResource: (resource: string) => boolean;
  /**
   * Whether a permission on the whole connection is a source too: the
   * account's own mailbox or drive. Without one (Google has no drive ID
   * for a person's My Drive), only a permission naming a resource is.
   */
  wholeConnection: boolean;
  /**
   * For a provider that can only read on from a position, not from a
   * time: where it stands now, as the source's first cursor, taken as
   * soon as the source starts (events.ts), so a first read that comes
   * late still reads everything since. Until it has one, the source reads
   * nothing. Without `prime`, a source's first read starts from when it
   * started.
   */
  prime?: (read: SourceRead) => Promise<string>;
  read: (read: SourceRead) => Promise<ReadEvents>;
}

/** Why a source's read failed, and what to do about it. */
export class SourceError extends Error {
  /** The provider asked to wait this long. */
  readonly retryAfterMs: number | undefined;
  /** The cursor can't be read on from: the next read starts over. */
  readonly resync: boolean;
  /** The provider's HTTP status, when it answered with an error. */
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { retryAfterMs?: number; resync?: boolean; status?: number } = {}
  ) {
    super(message);
    this.name = "SourceError";
    this.retryAfterMs = options.retryAfterMs;
    this.resync = options.resync ?? false;
    this.status = options.status;
  }
}

/**
 * Items after which one read of a source stops, which bounds its events
 * too: at most a page past it.
 */
export const readMaxItems = 100;
/** How long one request to a provider may take. */
const requestTimeoutMs = 15_000;
/** Largest answer read from a provider, in bytes. */
const answerMaxBytes = 4 * 1024 * 1024;
/** The longest a source that fails, or an event whose delivery does, waits. */
export const maxWaitMs = 60 * 60_000;
/**
 * How long before the last read an item may be dated and still be new: a
 * provider can show an item a little after the time it gives it.
 */
const lateItemMs = 10 * 60_000;

/**
 * The earliest an item may be dated and still be new to `source`: after
 * it started, and not long before its last read, so an item shown again
 * only because it changed (read, flagged, edited) isn't reported again.
 */
export const newSince = ({ createdAt, readAt }: EventSource): Date =>
  new Date(
    Math.max(
      createdAt.getTime(),
      readAt === null ? 0 : readAt.getTime() - lateItemMs
    )
  );

/** At or after `since`, by an ISO timestamp the provider wrote; false without one. */
export const isSince = (
  at: string | null | undefined,
  since: Date
): boolean => {
  const time = Date.parse(at ?? "");
  return Number.isFinite(time) && time >= since.getTime();
};

/** Seconds a `retry-after` header says, as milliseconds, up to an hour. */
const retryAfterMs = (header: string | null): number | undefined => {
  const seconds = Number(header);
  return header === null || !Number.isFinite(seconds) || seconds < 0
    ? undefined
    : Math.min(seconds * 1000, maxWaitMs);
};

/** Whether `url` is one to send the token to: HTTPS, on `hosts`, no credentials. */
const isProviderUrl = (url: string, hosts: readonly string[]): boolean => {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return (
    target.protocol === "https:" &&
    hosts.includes(target.hostname) &&
    target.username === "" &&
    target.password === ""
  );
};

/**
 * A link a provider handed back, to keep as a cursor: only one on its own
 * hosts. Any other starts the source over rather than being stored.
 */
export const providerLink = (
  url: string | undefined,
  hosts: readonly string[]
): string | undefined => {
  if (url !== undefined && !isProviderUrl(url, hosts)) {
    throw new SourceError("The provider handed back a link to another host", {
      resync: true,
    });
  }
  return url;
};

/**
 * Fetches JSON from a provider with the connection's token: only on
 * `hosts`, over HTTPS, never following a redirect (it would take the
 * token along). A throttled answer says how long to wait; a gone cursor
 * (410, or a status of `resyncStatuses`) starts the source over.
 */
export const readFromProvider =
  ({
    name,
    hosts,
    headers = {},
    resyncStatuses = [],
  }: {
    name: string;
    hosts: readonly string[];
    headers?: Record<string, string>;
    resyncStatuses?: readonly number[];
  }) =>
  async (token: string, url: string): Promise<unknown> => {
    if (!isProviderUrl(url, hosts)) {
      throw new SourceError(`${name} handed back a link to another host`, {
        resync: true,
      });
    }
    const response = await fetch(url, {
      headers: { ...headers, authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const { status } = response;
    if (status === 429 || status === 503) {
      throw new SourceError(`${name} is throttling reads`, {
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
        status,
      });
    }
    if (status === 410 || resyncStatuses.includes(status)) {
      throw new SourceError(`${name} no longer has the cursor`, {
        resync: true,
        status,
      });
    }
    if (!response.ok) {
      throw new SourceError(`${name} answered ${status}`, { status });
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > answerMaxBytes) {
      throw new SourceError(`${name}'s answer is too large`);
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // Not the parser's message: it quotes the answer.
      throw new SourceError(`${name}'s answer isn't JSON`);
    }
  };
