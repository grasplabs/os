import { actorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { fromBase64Url, toBase64Url } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  knowledgeErrors,
  purgeInputSchema,
  purgeMaxDocuments,
  purgedMarker,
} from "@grasp-os/shared/knowledge";
import type { PurgePlan, PurgeResult } from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin, roleErrors } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, count, eq, gt, inArray, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { inList, notInList } from "../db/d1.ts";
import {
  collections,
  documents,
  links,
  memoryProposals,
  sections,
  versions,
} from "../db/knowledge/schema.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { requireFeature } from "../features.ts";
import type { CollectionRow } from "./collections.ts";
import { checkedText, personWriter, writeVersion } from "./documents.ts";
import type { DocumentRow } from "./documents.ts";
import { personalCollectionId } from "./memory-files.ts";
import { failBatchIfProposals } from "./memory-proposals.ts";

// Purging personal data from Knowledge, for good, when someone leaves or
// asks (GDPR erasure): an admin prepares a purge, which says how much it
// removes and returns a token, and confirms it with that token. Two kinds:
//
// - `personal`: the person's Personal collection (their USER.md and
//   whatever else is in it) is deleted with every version, section, link
//   and search row, and so are the memory proposals their agents made,
//   which hold text from their chats. One batch, with its audit event.
// - `content`: every occurrence of some terms (a name, an email address, a
//   passage), in any case and as a whole word (never inside a longer
//   word, except in scripts written without spaces), is replaced with
//   `purgedMarker` in every version of the documents named, and in their
//   memory proposals. Preparing one also counts how often a term would
//   still start a longer word ("Toms"), so the admin can add those forms
//   as terms of their own. Whenever anything changed, the current text is also
//   saved as the next version, which makes its sections, links, search
//   rows and the document's title and description again, and fails for
//   anyone who saved meanwhile from text not yet purged.
//
// Then the search index is rebuilt from what it holds now: FTS5 keeps a
// deleted row's terms in its index pages, where they can't be found by a
// search but are still in the database, until a merge drops them, and
// `optimize` doesn't merge an index that is one segment already, which can
// still hold them. The rebuild runs after the data is committed, and on every purge, also one with nothing left to change, so
// when it fails (`knowledge.purge_index_pending`) running the purge again
// finishes it.
//
// The audit log can't be purged, so what it records of a purge is who,
// when, why (a reason from a fixed list), which documents and how many
// versions (and, when preparing, how often a term starts a longer word):
// never the terms or the text removed. Preparing is recorded too: its
// counts tell whether text is in a collection the admin can't read, so
// trying terms one by one leaves a trace.
//
// What a purge doesn't reach: paths (a document named after someone keeps
// its name), collection names and descriptions, other documents that
// quote the text, a term split by Markdown or a line break, a term
// spelled otherwise (a variant, an accent left out or encoded otherwise),
// a term joined to more of a word ("Toms", "tomVisser": not removed,
// only counted when it starts the word), memory already cached in a
// running isolate (never served again, gone once evicted), D1's own
// point-in-time recovery, and anything outside Knowledge. And it reaches too far where a name is an
// ordinary word too (Will, Mark, May): every "will" goes.

/** How long an admin has to confirm a purge they prepared. */
const tokenLifetimeMs = 10 * 60 * 1000;

/** Versions read at once when rewriting a document's: up to 1 MB each. */
const versionsPerPage = 5;

/**
 * Largest text and message of a version a purge writes, in bytes of UTF-8.
 * D1 keeps a row to 2 MB; this leaves the rest of the row a clear margin.
 * A version saved at the 1 MB limit grows past it when many short terms
 * become the longer marker.
 */
const rewrittenMaxBytes = 1.5 * 1024 * 1024;

type PurgeInput = z.output<typeof purgeInputSchema>;
type PersonalPurge = Extract<PurgeInput, { type: "personal" }>;
type ContentPurge = Extract<PurgeInput, { type: "content" }>;

interface Counts {
  documents: number;
  versions: number;
  proposals: number;
}

const nothing: Counts = { documents: 0, versions: 0, proposals: 0 };

const sum = (all: Counts[]): Counts => {
  const total = { ...nothing };
  for (const counts of all) {
    total.documents += counts.documents;
    total.versions += counts.versions;
    total.proposals += counts.proposals;
  }
  return total;
};

/**
 * Refuses anyone but the client's own admins: Grasp staff never purge the
 * client's data, whatever their role.
 */
const requirePurger = (person: Identity): void => {
  if (person.staff || !isAdmin(person.role)) {
    throw roleErrors.create("role.forbidden");
  }
};

const parseInput = (input: unknown): PurgeInput =>
  knowledgeErrors.parse("knowledge.invalid", purgeInputSchema, input);

const tokenKey = async (env: Env): Promise<CryptoKey> =>
  await derivedHmacKey(env, "grasp-os knowledge purge token", [
    "sign",
    "verify",
  ]);

/** What a token signs: the admin, the purge as parsed, and its expiry. */
const tokenData = (person: Identity, input: PurgeInput, expiresAt: number) =>
  new TextEncoder().encode(canonicalJson([person.userId, input, expiresAt]));

const tokenPattern = /^(?<expiresAt>\d{1,15})\.(?<mac>[\w-]{1,128})$/u;

/**
 * Refuses with `knowledge.purge_expired` unless `token` is one prepared by
 * `person` for exactly `input`, and not yet expired. It holds no purged
 * text: the admin sends the input again.
 */
const requireToken = async (
  env: Env,
  person: Identity,
  input: PurgeInput,
  token: unknown
): Promise<void> => {
  const groups =
    typeof token === "string" ? tokenPattern.exec(token)?.groups : undefined;
  const expiresAt = Number(groups?.expiresAt);
  let valid = false;
  if (groups?.mac !== undefined && expiresAt > Date.now()) {
    try {
      valid = await crypto.subtle.verify(
        "HMAC",
        await tokenKey(env),
        fromBase64Url(groups.mac),
        tokenData(person, input, expiresAt)
      );
    } catch {
      // Not base64url: not a token.
    }
  }
  if (!valid) {
    throw knowledgeErrors.create("knowledge.purge_expired");
  }
};

/** A token for `person` to confirm `input` with, and when it expires. */
const tokenFor = async (
  env: Env,
  person: Identity,
  input: PurgeInput
): Promise<{ token: string; expiresAt: string }> => {
  const expiresAt = Date.now() + tokenLifetimeMs;
  const mac = await crypto.subtle.sign(
    "HMAC",
    await tokenKey(env),
    tokenData(person, input, expiresAt)
  );
  return {
    token: `${expiresAt}.${toBase64Url(new Uint8Array(mac))}`,
    expiresAt: new Date(expiresAt).toISOString(),
  };
};

/**
 * Drops deleted rows' terms from the search index's pages for good, by
 * rebuilding it from its content: after a delete, FTS5 only marks them
 * deleted. Refuses with `knowledge.purge_index_pending` when it fails: the
 * data is deleted already, and running the purge again rebuilds again.
 */
const rebuildSearchIndex = async (db: DrizzleD1Database): Promise<void> => {
  try {
    await db.batch([
      db.run(sql`INSERT INTO search_words (search_words) VALUES ('rebuild')`),
      db.run(
        sql`INSERT INTO search_trigrams (search_trigrams) VALUES ('rebuild')`
      ),
    ]);
  } catch (error) {
    // The data is already deleted by now; running the purge again, which
    // always rebuilds, finishes the cleanup.
    log.error("knowledge.purge.rebuild_failed", errorFields(error));
    throw knowledgeErrors.create("knowledge.purge_index_pending");
  }
};

/** The audit event of preparing or running a purge: never its terms. */
const purgeEntry = (
  person: Identity,
  action: "knowledge.purge.prepared" | "knowledge.purged",
  input: PurgeInput,
  scope: { collectionId?: string; documentIds: string[] },
  counts: Partial<Counts> & { inLongerWords?: number },
  purgeId?: string
): AuditEntry => ({
  actor: actorOf(person),
  action,
  ...(scope.collectionId === undefined
    ? {}
    : { target: { type: "collection", id: scope.collectionId } }),
  provenance: scope.documentIds.slice(0, purgeMaxDocuments),
  detail: {
    ...(purgeId === undefined ? {} : { purgeId }),
    kind: input.type,
    reason: input.reason,
    ...(input.type === "personal"
      ? { userId: input.userId }
      : { terms: input.terms.length }),
    ...counts,
  },
});

// Personal purges.

/** The person's Personal collection's documents, as a subquery. */
const documentsIn = (db: DrizzleD1Database, collectionId: string) =>
  db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.collectionId, collectionId));

/** The memory proposals a personal purge deletes. */
const proposalsOf = (collectionId: string, userId: string) =>
  or(
    eq(memoryProposals.collectionId, collectionId),
    eq(memoryProposals.onBehalfOf, userId)
  );

/** What purging `userId`'s Personal collection deletes. */
const personalScope = async (
  db: DrizzleD1Database,
  { userId }: PersonalPurge
): Promise<{ collectionId: string; documentIds: string[]; counts: Counts }> => {
  const collectionId = await personalCollectionId(userId);
  const found = await documentsIn(db, collectionId);
  const [versionCount] = await db
    .select({ count: count() })
    .from(versions)
    .where(inArray(versions.documentId, documentsIn(db, collectionId)));
  const [proposalCount] = await db
    .select({ count: count() })
    .from(memoryProposals)
    .where(proposalsOf(collectionId, userId));
  return {
    collectionId,
    documentIds: found.map(({ id }) => id),
    counts: {
      documents: found.length,
      versions: versionCount?.count ?? 0,
      proposals: proposalCount?.count ?? 0,
    },
  };
};

/**
 * Deletes `userId`'s Personal collection, everything in it and their
 * agents' proposals, with the audit event, in one batch: all or nothing.
 * The sections go first, row by row, so the triggers take them out of the
 * search index; the rest in the order they refer to one another. The
 * search index is rebuilt after, also when nothing was left to delete.
 */
const purgePersonal = async (
  env: Env,
  person: Identity,
  input: PersonalPurge
): Promise<PurgeResult> => {
  const db = drizzle(env.KNOWLEDGE);
  const { collectionId, documentIds, counts } = await personalScope(db, input);
  const purgeId = crypto.randomUUID();
  const inCollection = documentsIn(db, collectionId);
  await auditedBatch(env, db, [
    db.delete(sections).where(inArray(sections.documentId, inCollection)),
    db.delete(links).where(inArray(links.fromDocumentId, inCollection)),
    db.delete(versions).where(inArray(versions.documentId, inCollection)),
    db.delete(memoryProposals).where(proposalsOf(collectionId, input.userId)),
    db.delete(documents).where(eq(documents.collectionId, collectionId)),
    db.delete(collections).where(eq(collections.id, collectionId)),
    outboxed(
      db,
      purgeEntry(
        person,
        "knowledge.purged",
        input,
        { collectionId, documentIds },
        counts,
        purgeId
      )
    ),
  ]);
  await rebuildSearchIndex(db);
  return { purgeId, ...counts };
};

// Content purges.

/** A term as a pattern: every character as itself. */
const literal = (term: string): string =>
  term.replaceAll(/[$()*+./?[\\\]^{|}]/gu, "\\$&");

/**
 * Scripts written without spaces between words (Chinese, Japanese, Thai,
 * Lao, Khmer, Burmese): a name in running text has letters on both sides,
 * so a character of one never makes a word longer.
 */
const unspacedScripts = String.raw`[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]`;

/**
 * A character that makes a word longer, in any script written with
 * spaces: a letter, a digit, an underscore, a combining mark (an accent
 * written as its own code point stays part of its letter's word), or one
 * of the invisible characters that sit inside words: a soft hyphen, a
 * zero-width non-joiner or joiner, a word joiner. Not the other invisible
 * ones (bidi marks and isolates, a byte order mark), which wrap a name
 * rather than join it. `\b` knows only ASCII, so it would split "José"
 * after the "Jos".
 */
const joining = String.raw`(?!${unspacedScripts})[\p{L}\p{M}\p{N}_\u00AD\u200C\u200D\u2060]`;
const startsJoining = new RegExp(`^${joining}`, "u");
const endsJoining = new RegExp(`${joining}$`, "u");

/**
 * Where a term becomes part of a longer word when the character next to
 * it joins it: at its start and end, when those join (a letter of "Tom"
 * does; the bracket of "(Tom)", the dot ending a passage, or a character
 * of a script written without spaces don't).
 */
const sidesOf = (term: string) => ({
  before: startsJoining.test(term),
  after: endsJoining.test(term),
});

/**
 * A term, and no joining character before it, where its start joins. The
 * check before comes after the term's own characters (looking behind them
 * and it), so it runs only where the whole term matched rather than at
 * every position: on text made to be slow, over twice as fast.
 */
const startingWord = (term: string): string => {
  const itself = literal(term);
  return sidesOf(term).before ? `${itself}(?<!${joining}${itself})` : itself;
};

/**
 * A term as a pattern that matches it as a whole word: never inside a
 * longer one, so "Tom" leaves "automated" and "Ann" leaves "planned", and
 * frontmatter keys and values that merely contain a term stay as they
 * are.
 */
const wholeWord = (term: string): string =>
  `${startingWord(term)}${sidesOf(term).after ? `(?!${joining})` : ""}`;

/**
 * A term as a pattern that matches it only where it starts a longer word
 * ("Toms", "Tomin", "tomVisser" for "Tom"): the forms of a name an admin
 * would add as terms. Not inside or at the end of one ("automated",
 * "custom"), which are other words. None for a term whose end no
 * character can join.
 */
const startOfWord = (term: string): string[] =>
  sidesOf(term).after ? [`${startingWord(term)}(?=${joining})`] : [];

/** Alternatives in any case, as one pattern; one that never matches if none. */
const anyOf = (alternatives: string[]): RegExp =>
  new RegExp(
    alternatives.length === 0 ? "(?!)" : alternatives.join("|"),
    "giu"
  );

/**
 * The terms: `anywhere` finds them in any case, as themselves, which is
 * cheap and tells whether a text needs the other patterns at all;
 * `remove` finds them as whole words; `joined`, only when preparing a
 * purge, where they start a longer word, which the purge leaves but
 * counts. Longest first, so a term inside a longer one doesn't leave the
 * rest of the longer one behind.
 */
interface Matcher {
  anywhere: RegExp;
  remove: RegExp;
  joined?: RegExp;
}

const matcherOf = (
  terms: string[],
  { countJoined }: { countJoined: boolean }
): Matcher => {
  const longestFirst = terms.toSorted(
    (one, other) => other.length - one.length
  );
  return {
    // Not global: `test` would carry `lastIndex` from one text to the next.
    anywhere: new RegExp(longestFirst.map(literal).join("|"), "iu"),
    remove: anyOf(longestFirst.map(wholeWord)),
    ...(countJoined
      ? { joined: anyOf(longestFirst.flatMap(startOfWord)) }
      : {}),
  };
};

/** `text` with every term replaced by the marker. */
const without = (text: string, matcher: Matcher): string =>
  matcher.anywhere.test(text)
    ? text.replaceAll(matcher.remove, purgedMarker)
    : text;

/**
 * How often a term still starts a longer word in `texts`, once rewritten
 * ("Toms" for "Tom"); 0 unless the matcher counts them.
 */
const joinedIn = (texts: (string | null)[], matcher: Matcher): number => {
  const { anywhere, joined } = matcher;
  if (joined === undefined) {
    return 0;
  }
  let total = 0;
  for (const text of texts) {
    if (text !== null && anywhere.test(text)) {
      total += text.match(joined)?.length ?? 0;
    }
  }
  return total;
};

/** A version's or proposal's text and message, rewritten if they change. */
const rewritten = (
  row: { text: string; message: string | null },
  matcher: Matcher
): { text: string; message: string | null } | undefined => {
  const text = without(row.text, matcher);
  const message = row.message === null ? null : without(row.message, matcher);
  return text === row.text && message === row.message
    ? undefined
    : { text, message };
};

interface Named {
  document: DocumentRow;
  collection: CollectionRow;
}

/**
 * The documents a content purge names, in ID order. Refuses with
 * `knowledge.not_found`, naming the ones that don't exist, rather than
 * skipping them: a mistyped ID would otherwise leave the text it was meant
 * for where it is, with a purge recorded as done.
 */
const documentsNamed = async (
  db: DrizzleD1Database,
  { documentIds }: ContentPurge
): Promise<Named[]> => {
  const found = await db
    .select({ document: documents, collection: collections })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(inList(documents.id, documentIds))
    .orderBy(asc(documents.id));
  const existing = new Set(found.map(({ document }) => document.id));
  const missing = documentIds.filter((id) => !existing.has(id));
  if (missing.length > 0) {
    throw knowledgeErrors.create("knowledge.not_found", {
      documentIds: missing,
    });
  }
  return found;
};

/** The text and message of `document`'s version `number`. */
const versionOf = async (
  db: DrizzleD1Database,
  document: DocumentRow,
  number: number
) =>
  await db
    .select({ text: versions.text, message: versions.message })
    .from(versions)
    .where(
      and(eq(versions.documentId, document.id), eq(versions.number, number))
    )
    .get();

/**
 * Refuses with `knowledge.invalid` unless the current version of `named`,
 * with the terms removed, can be saved as its next version: its
 * frontmatter still fits its type, and it is within a document's limits
 * and a memory file's. Checked for every document named, whether or not
 * its current text holds a term (a purge saves it again when an earlier
 * version does), before a purge changes anything, so one that can't be
 * finished changes nothing.
 */
const requireSavable = async (
  env: Env,
  db: DrizzleD1Database,
  { document, collection }: Named,
  matcher: Matcher
): Promise<void> => {
  const current = await versionOf(db, document, document.currentVersion);
  if (current === undefined) {
    return;
  }
  const text = rewritten(current, matcher)?.text ?? current.text;
  try {
    await checkedText(env, collection, document.path, text);
  } catch (error) {
    const code = knowledgeErrors.codeOf(error);
    if (code === undefined) {
      throw error;
    }
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        `terms: removing them from document ${document.id} leaves text that can't be saved (${code})`,
      ],
    });
  }
};

/**
 * Refuses with `knowledge.invalid` when version `number` of `document`,
 * rewritten, is over {@link rewrittenMaxBytes}: D1 would refuse the row.
 */
const requireStorable = (
  document: DocumentRow,
  number: number,
  { text, message }: { text: string; message: string | null }
): void => {
  const encoder = new TextEncoder();
  const bytes =
    encoder.encode(text).byteLength + encoder.encode(message ?? "").byteLength;
  if (bytes > rewrittenMaxBytes) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        `terms: removing them makes version ${number} of document ${document.id} too large to store (${bytes} bytes, at most ${rewrittenMaxBytes})`,
      ],
    });
  }
};

/**
 * Rewrites the versions of `document` up to `upTo` that hold a term, in
 * place, a page at a time; only counts them unless `write`. Returns how
 * many hold one and how often a term still starts a longer word in them
 * (`joinedIn`). Refuses with `knowledge.invalid`
 * when one would be too large to store (`requireStorable`): a purge scans
 * them all first, so one that can't be finished changes nothing.
 */
const rewriteVersions = async (
  db: DrizzleD1Database,
  document: DocumentRow,
  upTo: number,
  matcher: Matcher,
  write: boolean
): Promise<{ changed: number; joined: number }> => {
  let changedVersions = 0;
  let joined = 0;
  for (let after = 0; ;) {
    // oxlint-disable-next-line no-await-in-loop -- a page at a time, to bound memory
    const page = await db
      .select({
        number: versions.number,
        text: versions.text,
        message: versions.message,
      })
      .from(versions)
      .where(
        and(
          eq(versions.documentId, document.id),
          gt(versions.number, after),
          lte(versions.number, upTo)
        )
      )
      .orderBy(asc(versions.number))
      .limit(versionsPerPage);
    const rows = page.map((row) => ({ row, changed: rewritten(row, matcher) }));
    joined += joinedIn(
      rows.flatMap(({ row, changed }) => {
        const { text, message } = changed ?? row;
        return [text, message];
      }),
      matcher
    );
    const updates = rows.flatMap(({ row, changed }) => {
      if (changed !== undefined) {
        requireStorable(document, row.number, changed);
      }
      return changed === undefined
        ? []
        : [
            db
              .update(versions)
              .set(changed)
              .where(
                and(
                  eq(versions.documentId, document.id),
                  eq(versions.number, row.number)
                )
              ),
          ];
    });
    changedVersions += updates.length;
    const [first, ...rest] = updates;
    if (write && first) {
      // oxlint-disable-next-line no-await-in-loop -- a page at a time, to bound memory
      await db.batch([first, ...rest]);
    }
    const last = page.at(-1);
    if (last === undefined || page.length < versionsPerPage) {
      return { changed: changedVersions, joined };
    }
    after = last.number;
  }
};

/**
 * Updates of `document`'s memory proposals that hold a term, the IDs of
 * those waiting that were read (only those, rewritten or not, move to the
 * version a purge saves), and how often a term still starts a longer word
 * in them (`joinedIn`).
 */
const proposalRewrites = async (
  db: DrizzleD1Database,
  document: DocumentRow,
  matcher: Matcher
) => {
  const proposals = await db
    .select({
      id: memoryProposals.id,
      text: memoryProposals.text,
      message: memoryProposals.message,
      status: memoryProposals.status,
    })
    .from(memoryProposals)
    .where(
      and(
        eq(memoryProposals.collectionId, document.collectionId),
        eq(memoryProposals.path, document.path)
      )
    );
  let joined = 0;
  const updates = proposals.flatMap(({ id, text, message }) => {
    const changed = rewritten({ text, message }, matcher);
    const left = changed ?? { text, message };
    joined += joinedIn([left.text, left.message], matcher);
    return changed === undefined
      ? []
      : [
          db
            .update(memoryProposals)
            .set(changed)
            .where(eq(memoryProposals.id, id)),
        ];
  });
  const pendingIds = proposals
    .filter(({ status }) => status === "pending")
    .map(({ id }) => id);
  return { updates, pendingIds, joined };
};

/**
 * What purging the terms from `named` would change, and how often a term
 * would still start a longer word; checks it can.
 */
const countDocument = async (
  env: Env,
  db: DrizzleD1Database,
  named: Named,
  matcher: Matcher
): Promise<{ counts: Counts; joined: number }> => {
  const { document } = named;
  await requireSavable(env, db, named, matcher);
  const inVersions = await rewriteVersions(
    db,
    document,
    document.currentVersion,
    matcher,
    false
  );
  const inProposals = await proposalRewrites(db, document, matcher);
  return {
    counts: {
      documents: inVersions.changed + inProposals.updates.length > 0 ? 1 : 0,
      versions: inVersions.changed,
      proposals: inProposals.updates.length,
    },
    joined: inVersions.joined + inProposals.joined,
  };
};

/**
 * Purges the terms from `named`, as `person`: rewrites the earlier
 * versions that hold one in place, a page at a time; then, if anything
 * held one, saves the current text, without them, as the next version
 * (`writeVersion`), which makes the sections, links, search rows, title,
 * description, owner and tags again, and gives memory cached by version a
 * new key. In the same batch, the current version is rewritten in place
 * too, the memory proposals are rewritten, and those read waiting on the
 * version it had move to the new one, which has the same text but for the
 * terms.
 *
 * The proposals are read first, and the save is from the version the purge
 * started at, so anyone who saved, restored or proposed meanwhile, from
 * text the purge hadn't rewritten yet, makes it fail with
 * `knowledge.conflict`; running the purge again rewrites theirs too. A purge cut short leaves the current version as it
 * was, so running it again finishes it; one run again after it finished
 * finds nothing, and writes nothing.
 */
const purgeDocument = async (
  env: Env,
  db: DrizzleD1Database,
  person: Identity,
  named: Named,
  matcher: Matcher
): Promise<Counts> => {
  const { document, collection } = named;
  const at = document.currentVersion;
  const { updates, pendingIds } = await proposalRewrites(db, document, matcher);
  const earlier = await rewriteVersions(db, document, at - 1, matcher, true);
  const current = await versionOf(db, document, at);
  const changed = current && rewritten(current, matcher);
  const changedVersions = earlier.changed + (changed === undefined ? 0 : 1);
  if (current !== undefined && changedVersions + updates.length > 0) {
    await writeVersion(env, personWriter(person), {
      collection,
      path: document.path,
      text: changed?.text ?? current.text,
      ifVersion: at,
      message: "Personal data removed",
      restoredFrom: null,
      also: [
        ...(changed === undefined
          ? []
          : [
              db
                .update(versions)
                .set(changed)
                .where(
                  and(
                    eq(versions.documentId, document.id),
                    eq(versions.number, at)
                  )
                ),
            ]),
        ...updates,
        // A proposal made from version N after they were read would wait
        // on it with text this purge never saw: the batch fails, as a
        // conflict, and running the purge again rewrites it too.
        failBatchIfProposals(
          db,
          and(
            eq(memoryProposals.collectionId, document.collectionId),
            eq(memoryProposals.path, document.path),
            eq(memoryProposals.status, "pending"),
            eq(memoryProposals.baseVersion, at),
            notInList(memoryProposals.id, pendingIds)
          )
        ),
        ...(pendingIds.length === 0
          ? []
          : [
              db
                .update(memoryProposals)
                .set({ baseVersion: at + 1 })
                .where(
                  and(
                    inList(memoryProposals.id, pendingIds),
                    eq(memoryProposals.status, "pending"),
                    eq(memoryProposals.baseVersion, at)
                  )
                ),
            ]),
      ],
    });
  }
  return {
    documents: changedVersions + updates.length > 0 ? 1 : 0,
    versions: changedVersions,
    proposals: updates.length,
  };
};

/**
 * What a content purge would change, and how often a term would still
 * start a longer word (when `matcher` counts them), checking every
 * document first.
 */
const contentCounts = async (
  env: Env,
  db: DrizzleD1Database,
  named: Named[],
  matcher: Matcher
): Promise<{ counts: Counts; joined: number }> => {
  const counts: Counts[] = [];
  let joined = 0;
  for (const one of named) {
    // oxlint-disable-next-line no-await-in-loop -- one document at a time, to bound memory
    const document = await countDocument(env, db, one, matcher);
    counts.push(document.counts);
    joined += document.joined;
  }
  return { counts: sum(counts), joined };
};

/**
 * Purges the terms from the documents named: checked first, every version
 * of every one, a page at a time, so a purge that would leave one that
 * can't be saved or stored changes nothing; then recorded in the audit
 * log; then run, one document at a time. The search index is rebuilt
 * last, also when nothing was left to change, so running a purge again
 * finishes a cleanup that failed.
 */
const purgeContent = async (
  env: Env,
  person: Identity,
  input: ContentPurge
): Promise<PurgeResult> => {
  const db = drizzle(env.KNOWLEDGE);
  const named = await documentsNamed(db, input);
  const matcher = matcherOf(input.terms, { countJoined: false });
  await contentCounts(env, db, named, matcher);
  const purgeId = crypto.randomUUID();
  // Recorded before anything changes, so no purge goes unrecorded however
  // far it gets.
  await auditedBatch(env, db, [
    outboxed(
      db,
      purgeEntry(
        person,
        "knowledge.purged",
        input,
        { documentIds: named.map(({ document }) => document.id) },
        { documents: named.length },
        purgeId
      )
    ),
  ]);
  const done: Counts[] = [];
  for (const one of named) {
    // oxlint-disable-next-line no-await-in-loop -- one document at a time, to bound memory
    done.push(await purgeDocument(env, db, person, one, matcher));
  }
  await rebuildSearchIndex(db);
  return { purgeId, ...sum(done) };
};

/**
 * What the purge `input` would remove, for `person` to confirm with the
 * token returned. Admins only (not Grasp staff), behind `knowledge_purge`.
 * Recorded in the audit log, without the terms.
 */
export const preparePurge = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<PurgePlan> => {
  requireFeature(env, "knowledge_purge");
  requirePurger(person);
  const parsed = parseInput(input);
  const db = drizzle(env.KNOWLEDGE);
  let scope: { collectionId?: string; documentIds: string[] };
  let counts: Counts;
  // A personal purge deletes whole documents: nothing is left in a word.
  let joined = 0;
  if (parsed.type === "personal") {
    ({ counts, ...scope } = await personalScope(db, parsed));
  } else {
    const named = await documentsNamed(db, parsed);
    scope = { documentIds: named.map(({ document }) => document.id) };
    ({ counts, joined } = await contentCounts(
      env,
      db,
      named,
      matcherOf(parsed.terms, { countJoined: true })
    ));
  }
  await auditedBatch(env, db, [
    outboxed(
      db,
      purgeEntry(person, "knowledge.purge.prepared", parsed, scope, {
        ...counts,
        ...(parsed.type === "content" ? { inLongerWords: joined } : {}),
      })
    ),
  ]);
  return {
    ...counts,
    inLongerWords: joined,
    ...(await tokenFor(env, person, parsed)),
  };
};

/**
 * Runs the purge `input`, with the token `preparePurge` returned `person`
 * for it. What it removes is counted as it runs, so it may differ from
 * what was prepared; the counts returned are what it removed.
 */
export const purge = async (
  env: Env,
  person: Identity,
  input: unknown,
  token: unknown
): Promise<PurgeResult> => {
  requireFeature(env, "knowledge_purge");
  requirePurger(person);
  const parsed = parseInput(input);
  await requireToken(env, person, parsed, token);
  return parsed.type === "personal"
    ? await purgePersonal(env, person, parsed)
    : await purgeContent(env, person, parsed);
};
