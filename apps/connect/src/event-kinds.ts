import type { Json } from "@grasp-os/shared/json";

import type { Connection } from "./connections.ts";
import type { eventSources } from "./db/schema.ts";

// What an event type is to connect (events.ts), and how its sources are
// read from a provider: the types each provider's events module
// (graph-events.ts) implements.

/** A source's row. */
export type EventSource = typeof eventSources.$inferSelect;

/** What one read of a source has to go on. */
export interface SourceRead {
  source: EventSource;
  connection: Connection;
  /**
   * Goes through a provider's pages from `start`, each fetched with the
   * connection's token by `page`, until the provider says it's at the end
   * (`end`, a link to read on from next time) or `readMaxItems` are read
   * (`next`, a link to the rest). The items read, and where to go on.
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
  /** The connector's read action whose data an event carries. */
  action: string;
  /** Whether a permission's resource is one of this type's sources. */
  isResource: (resource: string) => boolean;
  read: (read: SourceRead) => Promise<ReadEvents>;
}

/** Why a source's read failed, and what to do about it. */
export class SourceError extends Error {
  /** The provider asked to wait this long. */
  readonly retryAfterMs: number | undefined;
  /** The cursor expired: the next read starts over, from now. */
  readonly resync: boolean;

  constructor(
    message: string,
    options: { retryAfterMs?: number; resync?: boolean } = {}
  ) {
    super(message);
    this.name = "SourceError";
    this.retryAfterMs = options.retryAfterMs;
    this.resync = options.resync ?? false;
  }
}

/** Most items one read of a source takes, which bounds its events too. */
export const readMaxItems = 100;
/** How long one request to a provider may take. */
const requestTimeoutMs = 15_000;
/** Largest answer read from a provider, in bytes. */
const answerMaxBytes = 4 * 1024 * 1024;
/** The longest a source that fails, or an event whose delivery does, waits. */
export const maxWaitMs = 60 * 60_000;

/** Seconds a `retry-after` header says, as milliseconds, up to an hour. */
const retryAfterMs = (header: string | null): number | undefined => {
  const seconds = Number(header);
  return header === null || !Number.isFinite(seconds) || seconds < 0
    ? undefined
    : Math.min(seconds * 1000, maxWaitMs);
};

/**
 * Fetches JSON from a provider with the connection's token: only on
 * `hosts`, over HTTPS, never following a redirect (it would take the
 * token along). A throttled answer says how long to wait; a gone cursor
 * (410) starts the source over.
 */
export const readFromProvider =
  ({
    name,
    hosts,
    headers = {},
  }: {
    name: string;
    hosts: readonly string[];
    headers?: Record<string, string>;
  }) =>
  async (token: string, url: string): Promise<unknown> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new SourceError(`${name} handed back a link that isn't a URL`);
    }
    if (
      target.protocol !== "https:" ||
      !hosts.includes(target.hostname) ||
      target.username !== "" ||
      target.password !== ""
    ) {
      throw new SourceError(`${name} handed back a link to another host`);
    }
    const response = await fetch(target, {
      headers: { ...headers, authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.status === 429 || response.status === 503) {
      throw new SourceError(`${name} is throttling reads`, {
        retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
      });
    }
    if (response.status === 410) {
      throw new SourceError(`${name} no longer has the cursor`, {
        resync: true,
      });
    }
    if (!response.ok) {
      throw new SourceError(`${name} answered ${response.status}`);
    }
    const text = await response.text();
    if (text.length > answerMaxBytes) {
      throw new SourceError(`${name}'s answer is too large`);
    }
    return JSON.parse(text);
  };
