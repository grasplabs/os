import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { DurableObject } from "cloudflare:workers";
import { asc, desc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

import {
  canonicalJson,
  chainHash,
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

/** What an append did: events added to the chain, and those it already had. */
export interface AppendResult {
  appended: number;
  duplicates: number;
}

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
    void migrateOnWake(ctx, migrations);
  }

  /**
   * Appends events in the given order, skipping any whose ID the log already
   * has. Validates every event first, so a malformed one appends nothing.
   */
  async append(batch: readonly AuditEvent[]): Promise<AppendResult> {
    // The object is the chain's last line of defence: it doesn't trust its
    // caller to have validated, and keeps only the fields the schema knows.
    const parsed = batch.map((event) => auditEventSchema.parse(event));
    // Hashing is async, so another append could otherwise run between
    // reading the head and writing after it, and fork the chain.
    return await this.ctx.blockConcurrencyWhile(async () => {
      const head = this.#head();
      const seen = new Set<string>();
      const entries: (ChainEntry & { id: string })[] = [];
      let prevHash = head?.hash ?? genesisHash;
      let seq = head?.seq ?? 0;
      for (const event of parsed) {
        if (!(seen.has(event.id) || this.#has(event.id))) {
          seen.add(event.id);
          seq += 1;
          const link = { seq, prevHash, event: canonicalJson(event) };
          // Each hash needs the one before it.
          // oxlint-disable-next-line no-await-in-loop
          prevHash = await chainHash(link);
          entries.push({ ...link, id: event.id, hash: prevHash });
        }
      }
      this.#db.transaction((tx) => {
        for (const entry of entries) {
          tx.insert(events).values(entry).run();
        }
      });
      return {
        appended: entries.length,
        duplicates: parsed.length - entries.length,
      };
    });
  }

  /** Events after position `after`, oldest first, at most one page. */
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

  #has(id: string): boolean {
    return (
      this.#db
        .select({ seq: events.seq })
        .from(events)
        .where(eq(events.id, id))
        .get() !== undefined
    );
  }

  #page(after: number): ChainEntry[] {
    return this.#db
      .select({
        seq: events.seq,
        prevHash: events.prevHash,
        hash: events.hash,
        event: events.event,
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
