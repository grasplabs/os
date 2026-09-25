import {
  auditEventMaxBytes,
  auditEventSchema,
  isAuditEventTooLarge,
} from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { canonicalJson } from "@grasp-os/shared/json";
import { log } from "@grasp-os/shared/log";
import { DurableObject } from "cloudflare:workers";
import { asc, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

import {
  chainHash,
  chainVersion,
  genesisHash,
  verifyChain,
} from "./audit-chain.ts";
import type { ChainEntry, ChainVerification } from "./audit-chain.ts";
import migrations from "./db/audit-log/migrations/migrations.js";
import { events } from "./db/audit-log/schema.ts";
import { migrateOnWake } from "./db/migrate.ts";
import { inJurisdiction } from "./durable-objects.ts";

/** How many entries one read returns at most. */
const pageSize = 500;

/**
 * What an append did: events added to the chain, and those it already had.
 * A conflict is a duplicate whose content differs from the stored event: a
 * bug or a forgery, never a plain redelivery.
 */
export interface AppendResult {
  appended: number;
  duplicates: number;
  conflicts: number;
}

/** An event ready to chain: its ID and canonical JSON. */
interface Incoming {
  id: string;
  event: string;
}

/** Validates an event and gives its canonical JSON, within the size cap. */
const prepare = (input: AuditEvent): Incoming => {
  // The object is the chain's last line of defence: it doesn't trust its
  // caller to have validated, and keeps only the fields the schema knows.
  const parsed = auditEventSchema.parse(input);
  const event = canonicalJson(parsed);
  if (isAuditEventTooLarge(event)) {
    throw new RangeError(
      `Audit event ${parsed.id} is over ${auditEventMaxBytes} bytes`
    );
  }
  return { id: parsed.id, event };
};

/**
 * The client's audit log: one object per deployment, in the EU. Appends
 * events in the order they arrive, each linked to the one before it by a
 * hash chain (src/audit-chain.ts), and appends each event ID only once.
 * Nothing updates or deletes an entry.
 */
export class AuditLog extends DurableObject<Env> {
  readonly #db = drizzle(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrateOnWake(ctx, migrations);
  }

  /**
   * Appends events in the given order, skipping any whose ID the log already
   * has. Validates every event first, so one malformed or oversized event
   * appends nothing from its batch.
   */
  async append(batch: readonly AuditEvent[]): Promise<AppendResult> {
    const incoming = batch.map((event) => prepare(event));
    // Hashing is async, so another append could otherwise run between
    // reading the head and writing after it, and fork the chain.
    return await this.ctx.blockConcurrencyWhile(async () => {
      const receivedAt = new Date().toISOString();
      const head = this.#head();
      // Every event this call has seen, by ID: stored ones and new ones.
      const known = new Map<string, string | undefined>();
      const entries: (ChainEntry & { id: string })[] = [];
      let conflicts = 0;
      let prevHash = head?.hash ?? genesisHash;
      let seq = head?.seq ?? 0;
      for (const { id, event } of incoming) {
        if (!known.has(id)) {
          known.set(id, this.#stored(id));
        }
        const existing = known.get(id);
        if (existing === undefined) {
          known.set(id, event);
          seq += 1;
          const link = {
            version: chainVersion,
            seq,
            prevHash,
            receivedAt,
            event,
          };
          // Each hash needs the one before it.
          // oxlint-disable-next-line no-await-in-loop
          prevHash = await chainHash(link);
          entries.push({ ...link, id, hash: prevHash });
        } else if (existing !== event) {
          conflicts += 1;
          log.warn("audit.conflicting_duplicate", { eventId: id });
        }
      }
      this.#db.transaction((tx) => {
        for (const entry of entries) {
          tx.insert(events).values(entry).run();
        }
      });
      return {
        appended: entries.length,
        duplicates: incoming.length - entries.length,
        conflicts,
      };
    });
  }

  /** Entries after position `after`, oldest first, at most one page. */
  entries(after = 0): ChainEntry[] {
    return this.#page(after);
  }

  /**
   * Checks the whole chain, from the first event to the last, and reports the
   * first position where it breaks: an event that was altered, removed or
   * moved.
   */
  async verify(): Promise<ChainVerification> {
    return await verifyChain(this.#all());
  }

  #head(): Pick<ChainEntry, "seq" | "hash"> | undefined {
    return this.#db
      .select({ seq: events.seq, hash: events.hash })
      .from(events)
      .orderBy(desc(events.seq))
      .limit(1)
      .get();
  }

  /** The stored canonical JSON of the event with this ID, if any. */
  #stored(id: string): string | undefined {
    return this.#db
      .select({ event: events.event })
      .from(events)
      .where(eq(events.id, id))
      .get()?.event;
  }

  #page(after: number): ChainEntry[] {
    return this.#db
      .select({
        version: events.version,
        seq: events.seq,
        prevHash: events.prevHash,
        receivedAt: events.receivedAt,
        event: events.event,
        hash: events.hash,
      })
      .from(events)
      .where(gt(events.seq, after))
      .orderBy(asc(events.seq))
      .limit(pageSize)
      .all();
  }

  /**
   * Every entry in position order, read a page at a time.
   * @yields {ChainEntry} each entry, oldest first
   */
  *#all(): Generator<ChainEntry> {
    let page = this.#page(0);
    while (page.length > 0) {
      yield* page;
      page = this.#page(page.at(-1)?.seq ?? 0);
    }
  }
}

/** The deployment's single audit log. */
export const auditLog = (env: Env): DurableObjectStub<AuditLog> =>
  inJurisdiction(env, env.AUDIT_LOG).getByName("audit-log");
