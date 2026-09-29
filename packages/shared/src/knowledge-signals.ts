import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { CollectionId, DocumentId } from "./ids.ts";

// Knowledge usage signals: what a collection's owner should look at, read
// from the audit log and the documents once a day (core's
// src/knowledge/signals.ts). Questions nothing answered, documents nobody
// reads, and documents past their review date, each for the owner of the
// collection it is about.
//
// A search that found nothing is in the audit log as a keyed hash of its
// words and how many words it had, never the words: people search for
// people, and the audit log can't be purged. So a question's signal names
// that key and counts, never what was asked. Keeping the words for owners
// to read would need a store of its own that purges and expires them;
// until there is one, owners see how often a question went unanswered in
// their collection, by how many askers, and when last.
//
// A question counts the searches of others than the collection's owner:
// a search in the collection, or, of every collection, one that came
// closest there. Only collection IDs are kept of that, never the words.
//
// An owner dismisses a signal they have seen. It stays dismissed until
// there is something new: a question comes back once it is asked again
// after it was dismissed, and a document's signal once it went away (the
// document was read or changed, or its review date moved on) and came
// back.

/** The days of searches a question's signal counts. */
export const questionWindowDays = 30;

/**
 * The days without a read, and without a change, that make a document
 * unread.
 */
export const unreadDays = 90;

/** Searches of one question in one collection, at least, for a signal. */
export const repeatedSearches = 2;

/** Most signals of each kind one `list` returns, highest value first. */
export const knowledgeSignalsPerKind = 50;

/** Every kind of signal. */
export const knowledgeSignalKinds = [
  "unanswered_question",
  "unread_document",
  "overdue_review",
] as const;
export type KnowledgeSignalKind = (typeof knowledgeSignalKinds)[number];

/** The collection a signal is about. */
export interface SignalCollection {
  id: CollectionId;
  name: string;
}

/** The document a signal is about, as it is now. */
export interface SignalDocument {
  id: DocumentId;
  path: string;
  title: string;
}

/**
 * The same search that found nothing, asked {@link repeatedSearches}
 * times or more in the last {@link questionWindowDays} days by others than
 * the collection's owner: in the collection, or, searching every
 * collection, coming closest there. Grouped by the search's key, an HMAC
 * of its words, never the words.
 */
export interface UnansweredQuestion {
  kind: "unanswered_question";
  id: string;
  collection: SignalCollection;
  /** Times others searched it in the window. */
  value: number;
  evidence: {
    /** The search's key: the same words, in any order, have the same one. */
    queryKey: string;
    searches: number;
    /**
     * How many different people, agents, App parts (screens or server
     * code) or runs searched it.
     */
    askers: number;
    /** How many words it had. */
    terms: number;
    /** When the audit log received the latest search (ISO 8601). */
    lastAt: string;
  };
}

/**
 * A document nobody read, and nobody changed, for the last `days` days.
 */
export interface UnreadDocument {
  kind: "unread_document";
  id: string;
  collection: SignalCollection;
  /** Days since it last changed. */
  value: number;
  evidence: {
    document: SignalDocument;
    /** When it last changed (ISO 8601). */
    updatedAt: string;
    /**
     * The days nobody read it: {@link unreadDays}, or the audit log's
     * retention where that's shorter, as the log keeps no reads past it.
     */
    days: number;
  };
}

/** A document past its review date. */
export interface OverdueReview {
  kind: "overdue_review";
  id: string;
  collection: SignalCollection;
  /** Days past its review date. */
  value: number;
  evidence: {
    document: SignalDocument;
    /** `YYYY-MM-DD`. */
    reviewDate: string;
  };
}

/** One Knowledge usage signal. */
export type KnowledgeSignal =
  | UnansweredQuestion
  | UnreadDocument
  | OverdueReview;

/** The signals as of the latest daily computation. */
export interface KnowledgeSignals {
  /** When they were computed (ISO 8601); null before the first time. */
  computedAt: string | null;
  signals: KnowledgeSignal[];
}

/** A signal's ID, as `list` returns it. */
export const knowledgeSignalIdSchema = z.uuid();

/** Why a Knowledge signals call was refused. */
export const knowledgeSignalErrors = defineErrorFamily({
  "knowledge_signal.invalid": "That isn't a signal's ID.",
  "knowledge_signal.not_found":
    "There's no such signal, or it isn't about a collection you own.",
});

/**
 * Knowledge usage signals, for the owners of the collections they are
 * about. Listing them is audited, and so is dismissing one.
 */
export interface KnowledgeSignalsApi {
  /**
   * The signals about the collections the person owns, but those they
   * dismissed with nothing new since: at most
   * {@link knowledgeSignalsPerKind} of each kind, highest value first.
   */
  list: () => Promise<KnowledgeSignals>;
  /** Dismisses a signal `list` returned, until there is something new. */
  dismiss: (signalId: string) => Promise<void>;
}
