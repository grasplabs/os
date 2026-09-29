import type { AuditDetailValue, AuditEvent } from "@grasp-os/shared/audit";

import { askerOf } from "../signal-tally.ts";

// What the Knowledge usage signals (signals.ts) need of the audit log: the
// documents read, and the searches that found nothing, per collection, key
// and asker. The AuditLog object tallies one stretch of the log at a time
// with these (`AuditLog.tallyStretch`), so only small partial totals cross
// to the Worker, which adds them up.

/** Most collections an empty search of every collection is put down to. */
export const nearestCollectionsMax = 3;

/**
 * The collections a search of every collection that found nothing came
 * closest in, for its audit event's `detail.nearest` (search.ts): their
 * IDs, comma-separated, never its words or any document.
 */
export const nearestDetail = (collectionIds: readonly string[]): string =>
  collectionIds.slice(0, nearestCollectionsMax).join(",");

/** The collections an empty search is about: the one it named, or nearest. */
const collectionsOf = (
  target: AuditEvent["target"],
  nearest: AuditDetailValue | undefined
): string[] => {
  if (target?.type === "collection") {
    return [target.id];
  }
  if (typeof nearest !== "string") {
    return [];
  }
  return nearest
    .split(",")
    .filter((id) => id !== "")
    .slice(0, nearestCollectionsMax);
};

/** One asker's searches for one key in one collection, in a stretch. */
export interface CollectionQuestion {
  collectionId: string;
  queryKey: string;
  asker: string;
  searches: number;
  terms: number;
  /** When the log received the latest of them (ISO 8601). */
  lastAt: string;
}

/** A stretch's partial totals. */
export interface KnowledgeTally {
  /** The documents read, each once. */
  read: string[];
  questions: CollectionQuestion[];
}

/**
 * The reads (`detail.read`) of several documents at once that read what
 * they say: an agent's memory files, a page of Playbook records. Listing
 * an agent's skills names them, every turn, without reading one, so it
 * doesn't count, nor does listing a collection's documents.
 */
const contentReads = new Set(["memory", "records"]);

/** The documents a read of several at once read: in its provenance. */
const readsInProvenance = ({ detail, provenance }: AuditEvent): string[] =>
  typeof detail.read === "string" && contentReads.has(detail.read)
    ? (provenance ?? [])
    : [];

/**
 * Tallies events, one after another, oldest first: every read of a
 * document from `readsFrom` (ISO 8601) on, and the searches that found
 * nothing from `questionsFrom` on. A read names its document as its
 * target, or, for reads of several at once (`contentReads`), in its
 * provenance, beside the collections. A search that found nothing is
 * put down to the collection it named, or else to those it came closest
 * in; a search with neither, or without words, is left out.
 */
export class KnowledgeTallier {
  readonly #readsFrom: string;
  readonly #questionsFrom: string;
  readonly #read = new Set<string>();
  readonly #questions = new Map<string, CollectionQuestion>();

  constructor(readsFrom: string, questionsFrom: string) {
    this.#readsFrom = readsFrom;
    this.#questionsFrom = questionsFrom;
  }

  add(event: AuditEvent, receivedAt: string) {
    if (event.action === "knowledge.read" && receivedAt >= this.#readsFrom) {
      const read =
        event.target?.type === "document"
          ? [event.target.id]
          : readsInProvenance(event);
      for (const id of read) {
        this.#read.add(id);
      }
      return;
    }
    if (
      event.action === "knowledge.search.empty" &&
      receivedAt >= this.#questionsFrom
    ) {
      this.#addQuestion(event, receivedAt);
    }
  }

  #addQuestion({ actor, detail, target }: AuditEvent, receivedAt: string) {
    const { queryKey, terms, nearest } = detail;
    if (typeof queryKey !== "string" || typeof terms !== "number") {
      return;
    }
    if (terms === 0) {
      return;
    }
    const asker = askerOf(actor);
    for (const collectionId of collectionsOf(target, nearest)) {
      const key = JSON.stringify([collectionId, queryKey, asker]);
      const found = this.#questions.get(key) ?? {
        collectionId,
        queryKey,
        asker,
        searches: 0,
        terms,
        lastAt: receivedAt,
      };
      found.searches += 1;
      found.lastAt = receivedAt;
      this.#questions.set(key, found);
    }
  }

  totals(): KnowledgeTally {
    return { read: [...this.#read], questions: [...this.#questions.values()] };
  }
}
