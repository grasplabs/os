import type { AuditEntry } from "@grasp-os/shared/audit";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import {
  collectionSearchOptionsSchema,
  documentTypeSchema,
  searchOptionsSchema,
  searchQuerySchema,
} from "@grasp-os/shared/knowledge";
import type { SearchHit, SearchResults } from "@grasp-os/shared/knowledge";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { outboxed, sendAuditOutboxNow } from "../audit-outbox.ts";
import { actorOf, delegateActorOf } from "../audit.ts";
import { allowedCollections, recordRead } from "./access.ts";
import type { Reader } from "./access.ts";
import { readableCollection } from "./collections.ts";
import { parseOrInvalid } from "./documents.ts";

// Full-text search over sections, in two FTS5 indexes kept by triggers on
// the sections table (see the migration `0001_search.sql`): whole words,
// with diacritics removed and prefixes indexed ("vakan" finds
// "vakantiedagen", "financiele" finds "financiële"), and trigrams, which
// find a word inside a compound ("verlof" in "zwangerschapsverlof").
//
// One statement asks up to three passes, and a section counts in the first
// that finds it: whole words first, then trigrams; and only when neither
// finds anything, trigrams with room for one typo. Within a pass sections
// rank by BM25 with field weights (title, then description, headings and
// text) and by freshness. Every word of the query must match (AND): a
// search narrows as it gets longer.
//
// Access is part of the same statement (R11): a section of a collection
// the reader can't read is never ranked, counted or returned. What comes
// back is recorded as a read (`recordRead`), so a search that finds
// restricted data puts the App or agent's chat or App in restricted mode
// before the results are handed over, as any read does.

/** Most words of a query that count; the rest are left out. */
const maxTerms = 16;

/** Shortest word the trigram index can find: one trigram. */
const trigramLength = 3;

/**
 * The typo pass cuts a word in three pieces and asks for any two of them:
 * one typo changes one piece at most, so the other two are in the word as
 * it's spelled right. Two halves would be too loose for Dutch, where half a
 * compound is often a word of its own ("regeling" of "pensioenregeling").
 * Each piece is a trigram at least, so only long words get the pass: the
 * compounds a typo most often lands in.
 */
const typoPieces = 3;
const typoLength = typoPieces * trigramLength;

/** Most sections of one document in one search's results. */
const maxHitsPerDocument = 3;

/** BM25 weights per column: title, description, headings, text. */
const fieldWeights = sql.raw("10.0, 5.0, 3.0, 1.0");

/** The same, for what belongs to the section alone: headings and text. */
const sectionWeights = sql.raw("0.0, 0.0, 3.0, 1.0");

/** Tokens of text around a whole-word match; trigrams are characters. */
const snippetWords = 24;
const snippetCharacters = 64;

const yearMs = 365 * 24 * 60 * 60 * 1000;

/** Whatever isn't a letter or a digit separates words. */
const wordPattern = /[\p{L}\p{N}]+/gu;

/** A query's distinct words: lowercased, at most {@link maxTerms}. */
const termsOf = (query: string): string[] =>
  [...new Set(query.normalize("NFKC").toLowerCase().match(wordPattern))].slice(
    0,
    maxTerms
  );

/** An FTS5 string: words only, so quoting is all it needs. */
const quoted = (term: string) => `"${term}"`;

/**
 * A long word as the typo pass asks for it: two of its three pieces, close
 * together, as they are in the word spelled right. Pieces far apart in a
 * section ("zwang…" and "…zonder" in "bijzonder verlof of zwangerschap")
 * aren't a typo. FTS5 counts the distance in trigrams: between two pieces
 * of the word lie at most the middle piece, a typo and two trigrams.
 */
const allowingTypo = (letters: string[]): string => {
  const bounds = Array.from({ length: typoPieces + 1 }, (_, index) =>
    Math.floor((index * letters.length) / typoPieces)
  );
  const pieces = bounds
    .slice(0, -1)
    .map((start, index) =>
      quoted(letters.slice(start, bounds[index + 1]).join(""))
    );
  const near = Math.ceil(letters.length / typoPieces) + trigramLength;
  const [first, second, third] = pieces;
  return [
    [first, second],
    [first, third],
    [second, third],
  ]
    .map(([one, other]) => `NEAR(${one} ${other}, ${near})`)
    .join(" OR ");
};

/** The typo pass: only asked for when the others find nothing. */
const typoPass = 2;

interface Pass {
  table: string;
  pass: number;
  match: string;
  /**
   * Words too short for trigrams, which the section must then have as
   * words, so that every word of the query still counts.
   */
  short?: string;
}

/** The FTS5 queries of each pass that has one, in order. */
const passesOf = (terms: string[]): Pass[] => {
  const words = (list: string[]) =>
    list.map((term) => `${quoted(term)}*`).join(" AND ");
  const letters = terms.map((term) => ({
    term,
    // Code points, as the trigram tokenizer counts them. Terms are letters
    // and digits only (`wordPattern`): no emoji or joiners to split.
    // oxlint-disable-next-line typescript/no-misused-spread -- see above
    chars: [...term],
  }));
  const long = letters.filter(({ chars }) => chars.length >= trigramLength);
  const short = letters
    .filter(({ chars }) => chars.length < trigramLength)
    .map(({ term }) => term);
  const trigrams = (query: string): Pass | undefined =>
    long.length === 0
      ? undefined
      : {
          table: "search_trigrams",
          pass: 0,
          match: query,
          ...(short.length === 0 ? {} : { short: words(short) }),
        };
  const typo = long.map(({ term, chars }) =>
    chars.length < typoLength ? quoted(term) : `(${allowingTypo(chars)})`
  );
  return [
    { table: "search_words", pass: 0, match: words(terms) },
    trigrams(long.map(({ term }) => quoted(term)).join(" AND ")),
    long.some(({ chars }) => chars.length >= typoLength)
      ? trigrams(typo.join(" AND "))
      : undefined,
  ].flatMap((pass, index) =>
    pass === undefined ? [] : [{ ...pass, pass: index }]
  );
};

/**
 * One pass's matches, with their BM25 score and the score of the section's
 * own headings and text alone.
 */
const matchesSql = ({ table, pass, match, short }: Pass): SQL => {
  const name = sql.identifier(table);
  return sql`SELECT rowid AS row_id, ${pass} AS pass,
      bm25(${name}, ${fieldWeights}) AS score,
      bm25(${name}, ${sectionWeights}) AS own
    FROM ${name} WHERE ${name} MATCH ${match}
    ${
      short === undefined
        ? sql``
        : sql`AND rowid IN (
            SELECT rowid FROM search_words WHERE search_words MATCH ${short}
          )`
    }`;
};

/**
 * The snippet of the section `row_id` of the results, from the pass that
 * found it: made only for the sections returned, not for every match.
 */
const snippetSql = (passes: Pass[]): SQL => {
  const cases = passes.map(({ table, pass, match }) => {
    const name = sql.identifier(table);
    const size = table === "search_words" ? snippetWords : snippetCharacters;
    return sql`WHEN ${pass} THEN (
      SELECT snippet(${name}, 3, '', '', '…', ${sql.raw(String(size))})
      FROM ${name} WHERE ${name} MATCH ${match} AND rowid = ranked.row_id
    )`;
  });
  return sql`CASE ranked.pass ${sql.join(cases, sql` `)} END`;
};

const hitRowSchema = z.object({
  documentId: z.string(),
  collectionId: z.string(),
  sensitive: z.number(),
  path: z.string(),
  title: z.string(),
  type: z.string(),
  description: z.string(),
  section: z.number(),
  headings: z.string(),
  snippet: z.string(),
});

const headingsSchema = z.array(z.string());

const toHit = (row: z.infer<typeof hitRowSchema>): SearchHit => ({
  documentId: documentIdSchema.parse(row.documentId),
  collectionId: collectionIdSchema.parse(row.collectionId),
  path: row.path,
  title: row.title,
  type: documentTypeSchema.parse(row.type),
  description: row.description,
  section: row.section,
  headings: headingsSchema.parse(JSON.parse(row.headings)),
  snippet: row.snippet,
});

/**
 * A key for grouping searches that found nothing, without their words:
 * an HMAC of the query's sorted words, keyed from the deployment's auth
 * secret. A plain hash of a short query can be reversed by guessing it
 * ("ziekmelding jan de vries"), and the audit log can't be purged.
 */
const queryKey = async (env: Env, terms: string[]): Promise<string> => {
  const secret = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    "HKDF",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: new TextEncoder().encode("grasp-os knowledge search query key"),
    },
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const normalized = terms
    .map((term) => term.normalize("NFKD").replaceAll(/\p{M}/gu, ""))
    .toSorted()
    .join(" ");
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalized)
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Records a search that found nothing the reader may read, for the usage
 * signals that tell owners what's missing: who searched, where, how many
 * words, and a key to group the same question by. Never the words
 * themselves: people search for people, and the audit log keeps
 * everything for good.
 */
const recordNothingFound = async (
  env: Env,
  reader: Reader,
  terms: string[],
  collectionId: string | undefined
): Promise<void> => {
  const entry: AuditEntry = {
    actor:
      reader.type === "person"
        ? actorOf(reader.person)
        : delegateActorOf(reader.authority),
    action: "knowledge.search.empty",
    ...(collectionId === undefined
      ? {}
      : { target: { type: "collection", id: collectionId } }),
    detail: { terms: terms.length, queryKey: await queryKey(env, terms) },
  };
  const db = drizzle(env.KNOWLEDGE);
  await outboxed(db, entry);
  await sendAuditOutboxNow(env);
};

/**
 * The sections that match `query`, best first, in the collections `reader`
 * may read, or in the one `options` names. A collection's stub passes its
 * own as `only`, and its options can't name another.
 */
export const search = async (
  env: Env,
  reader: Reader,
  query: unknown,
  options?: unknown,
  only?: string
): Promise<SearchResults> => {
  const terms = termsOf(parseOrInvalid(searchQuerySchema, query));
  const { collectionId: scope, limit } =
    only === undefined
      ? parseOrInvalid(searchOptionsSchema, options)
      : {
          ...parseOrInvalid(collectionSearchOptionsSchema, options),
          collectionId: only,
        };
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  // Refused like any read of a collection the reader can't read. A search
  // in one collection reads from it whatever it finds: that nothing
  // matches says something of what it holds too. So the collection is
  // among the read's sources, and a sensitive one restricts the reader
  // even when nothing is found, or a delegate could probe it word by word
  // and send out what it learned.
  const scoped =
    scope === undefined ? [] : [await readableCollection(db, allowed, scope)];
  if (terms.length === 0) {
    return { hits: [], provenance: await recordRead(env, reader, ...scoped) };
  }
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  // Freshness scales a score by 0.5 to 1: a quarter off for a year without
  // changes, and a quarter off past the review date. It orders sections that
  // match about as well; it doesn't lift a poor match over a good one.
  const freshness = sql`(1.0
    - 0.25 * min(1.0, max(0.0, (${now} - documents.updated_at) / (${yearMs} * 1.0)))
    - (CASE WHEN documents.review_date < ${today} THEN 0.25 ELSE 0.0 END))`;
  // Every section of a document repeats its title and description, so a
  // document ranks by its best section, and its sections follow one another
  // in the order their own headings and text match.
  const passes = passesOf(terms);
  const rows = await db.all(sql`
    WITH matches AS (${sql.join(passes.map(matchesSql), sql` UNION ALL `)}),
    readable AS (
      SELECT matches.row_id, matches.pass, matches.own,
        matches.score * ${freshness} AS rank,
        search_rows.document_id, search_rows.position,
        collections.id AS collection_id, collections.sensitive,
        row_number() OVER (PARTITION BY matches.row_id ORDER BY matches.pass) AS nth
      FROM matches
      JOIN search_rows ON search_rows.id = matches.row_id
      JOIN documents ON documents.id = search_rows.document_id
      JOIN collections ON collections.id = documents.collection_id
      WHERE ${allowed}
        ${scope === undefined ? sql`` : sql`AND collections.id = ${scope}`}
    ),
    found AS (
      SELECT * FROM readable
      WHERE nth = 1 AND (pass < ${typoPass}
        OR NOT EXISTS (SELECT 1 FROM readable WHERE pass < ${typoPass}))
    ),
    ranked AS (
      SELECT *,
        row_number() OVER (
          PARTITION BY document_id ORDER BY pass, own, rank
        ) AS in_document,
        first_value(pass) OVER document AS document_pass,
        first_value(rank) OVER document AS document_rank
      FROM found
      WINDOW document AS (PARTITION BY document_id ORDER BY pass, rank)
    ),
    top AS (
      SELECT * FROM ranked
      WHERE in_document <= ${maxHitsPerDocument}
      ORDER BY document_pass, document_rank, document_id, in_document
      LIMIT ${limit}
    )
    SELECT ranked.document_id AS documentId,
      ranked.collection_id AS collectionId, ranked.sensitive,
      documents.path, documents.title, documents.type, documents.description,
      ranked.position AS section, sections.headings,
      ${snippetSql(passes)} AS snippet
    FROM top AS ranked
    JOIN documents ON documents.id = ranked.document_id
    JOIN sections ON sections.document_id = ranked.document_id
      AND sections.position = ranked.position
    ORDER BY ranked.document_pass, ranked.document_rank, ranked.document_id,
      ranked.in_document
  `);
  const found = z.array(hitRowSchema).parse(rows);
  if (found.length === 0) {
    await recordNothingFound(env, reader, terms, scope);
  }
  const provenance = await recordRead(
    env,
    reader,
    ...scoped,
    ...found.map((row) => ({
      id: row.collectionId,
      sensitive: row.sensitive !== 0,
    }))
  );
  return { hits: found.map(toHit), provenance };
};
