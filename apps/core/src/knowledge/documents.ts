import type { AuditActor, AuditEntry } from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import {
  documentTypeOf,
  historyOptionsSchema,
  knowledgeErrors,
  listDocumentsOptionsSchema,
  playbookRecordTypes,
  restoreInputSchema,
  saveInputSchema,
  versionInputSchema,
} from "@grasp-os/shared/knowledge";
import type {
  Backlink,
  BacklinkPage,
  DocumentPage,
  DocumentRead,
  DocumentSummary,
  DocumentType,
  HistoryPage,
  Version,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { auditedBatch, outboxed } from "../audit-outbox.ts";
import { isUniqueViolation } from "../db/d1.ts";
import {
  collections,
  documents,
  links,
  sections,
  versions,
} from "../db/knowledge/schema.ts";
import { allowedCollections, noteProvenance } from "./access.ts";
import type { Reader } from "./access.ts";
import { readableCollection, requireWritable } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import { FrontmatterError, parseFrontmatter } from "./frontmatter.ts";
import { extractLinks, splitSections } from "./markdown.ts";
import type { Link, Section } from "./markdown.ts";
import { memoryFileOf, requireWithinLimit } from "./memory-files.ts";

// Saving a document: its frontmatter is read and checked (and a memory
// file's size, memory-files.ts), its Markdown split into sections and its
// links found, and then one D1 batch (a transaction)
// adds the next version, replaces the sections and links, updates the
// document and stores the audit event. The batch commits whole or not at
// all, and a save from a version that is no longer current writes nothing.

/**
 * Largest document text, in bytes of UTF-8. D1 keeps a row to 2 MB; the
 * version holds the whole text, with room to spare.
 */
const documentMaxBytes = 1024 * 1024;

/** Most sections one document has. */
const documentMaxSections = 1000;

/** Most distinct links one document has. */
export const documentMaxLinks = 500;

/** D1 binds at most 100 parameters to one statement. */
const maxBoundParameters = 100;

export type DocumentRow = typeof documents.$inferSelect;

/** What a save writes, read from the text. */
interface Prepared {
  type: DocumentType;
  title: string;
  description: string;
  owner: string | undefined;
  tags: string[];
  reviewDate: string | null;
  sections: Section[];
  links: Link[];
  /** A snapshot's workflow records, at the versions it freezes. */
  frozen: { path: string; version: number }[];
}

const recordTypes: ReadonlySet<string> = new Set(playbookRecordTypes);

const isPlaybookRecord = (type: DocumentType): boolean => recordTypes.has(type);

const invalid = (issues: string[]) =>
  knowledgeErrors.create("knowledge.invalid", { issues });

const fileTitle = (path: string): string => {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/**
 * Reads the text of the document at `path`, within the limits a save
 * keeps. Its title is the frontmatter's, else a skill's name, else its
 * first heading, else its file name.
 */
const prepare = (path: string, text: string): Prepared => {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > documentMaxBytes) {
    throw knowledgeErrors.create("knowledge.too_large", {
      bytes,
      maxBytes: documentMaxBytes,
    });
  }
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(path, text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw invalid(error.issues);
    }
    throw error;
  }
  const { type, frontmatter, body } = parsed;
  const found = splitSections(body);
  if (found.length > documentMaxSections) {
    throw knowledgeErrors.create("knowledge.too_many_sections", {
      sections: found.length,
      maxSections: documentMaxSections,
    });
  }
  const linked = extractLinks(body);
  if (linked.length > documentMaxLinks) {
    throw knowledgeErrors.create("knowledge.too_many_links", {
      links: linked.length,
      maxLinks: documentMaxLinks,
    });
  }
  const name = "name" in frontmatter ? frontmatter.name : undefined;
  const firstHeading = found
    .map(({ headings }) => headings[0] ?? "")
    .find((heading) => heading !== "");
  return {
    type,
    title: frontmatter.title ?? name ?? firstHeading ?? fileTitle(path),
    description: frontmatter.description,
    owner: frontmatter.owner,
    tags: frontmatter.tags,
    reviewDate: frontmatter.review ?? null,
    sections: found,
    links: linked,
    frozen: "workflows" in frontmatter ? frontmatter.workflows : [],
  };
};

/** Versions read at once to check a snapshot: up to 1 MB each. */
const frozenPerQuery = 5;

/** One version of the document at `path`, as a key. */
const keyOf = ({ path, version }: { path: string; version: number }): string =>
  JSON.stringify([path, version]);

/** The type of a saved version's `text`, if it still reads as one. */
const savedTypeOf = (path: string, text: string): DocumentType | undefined => {
  try {
    return parseFrontmatter(path, text).type;
  } catch (error) {
    if (error instanceof FrontmatterError) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Refuses with `knowledge.invalid` a snapshot in `collection` that
 * freezes a version it doesn't have, or one that wasn't a workflow record:
 * each version is judged by its own text, as the snapshot froze it.
 * Versions are never deleted, so a snapshot that was valid stays valid,
 * restored too.
 */
const requireFrozenVersions = async (
  env: Env,
  collection: CollectionRow,
  frozen: Prepared["frozen"]
): Promise<void> => {
  const wanted = [
    ...new Map(frozen.map((entry) => [keyOf(entry), entry])).values(),
  ];
  const db = drizzle(env.KNOWLEDGE);
  const types = new Map<string, DocumentType | undefined>();
  for (let start = 0; start < wanted.length; start += frozenPerQuery) {
    const page = wanted.slice(start, start + frozenPerQuery);
    // oxlint-disable-next-line no-await-in-loop -- a few versions at a time
    const rows = await db
      .select({
        path: documents.path,
        version: versions.number,
        text: versions.text,
      })
      .from(versions)
      .innerJoin(documents, eq(documents.id, versions.documentId))
      .where(
        and(
          eq(documents.collectionId, collection.id),
          sql`(${documents.path}, ${versions.number}) IN (SELECT json_extract(value, '$.path'), json_extract(value, '$.version') FROM json_each(${JSON.stringify(page)}))`
        )
      );
    for (const row of rows) {
      types.set(keyOf(row), savedTypeOf(row.path, row.text));
    }
  }
  const problems = frozen.flatMap((entry, index) => {
    const at = `frontmatter.workflows.${index}`;
    if (!types.has(keyOf(entry))) {
      return [
        `${at}: the Playbook has no version ${entry.version} of ${entry.path}`,
      ];
    }
    if (types.get(keyOf(entry)) !== "workflow") {
      return [
        `${at}: version ${entry.version} of ${entry.path} isn't a workflow record`,
      ];
    }
    return [];
  });
  if (problems.length > 0) {
    throw invalid(problems);
  }
};

/** Splits rows so no insert binds more parameters than D1 allows. */
const inChunks = <Row extends object>(rows: Row[]): Row[][] => {
  const [first] = rows;
  if (!first) {
    return [];
  }
  const size = Math.floor(maxBoundParameters / Object.keys(first).length);
  const chunks: Row[][] = [];
  for (let start = 0; start < rows.length; start += size) {
    chunks.push(rows.slice(start, start + size));
  }
  return chunks;
};

const tagsSchema = z.array(z.string());

export const toSummary = (row: DocumentRow): DocumentSummary => ({
  id: documentIdSchema.parse(row.id),
  collectionId: collectionIdSchema.parse(row.collectionId),
  path: row.path,
  title: row.title,
  type: documentTypeOf(row.type),
  description: row.description,
  owner: row.owner,
  tags: tagsSchema.parse(JSON.parse(row.tags)),
  reviewDate: row.reviewDate,
  currentVersion: row.currentVersion,
  updatedAt: row.updatedAt.toISOString(),
});

const versionSummaryColumns = {
  number: versions.number,
  author: versions.author,
  message: versions.message,
  restoredFrom: versions.restoredFrom,
  createdAt: versions.createdAt,
};

const toVersionSummary = (row: {
  number: number;
  author: string;
  message: string | null;
  restoredFrom: number | null;
  createdAt: Date;
}): VersionSummary => ({
  number: row.number,
  author: row.author,
  message: row.message,
  restoredFrom: row.restoredFrom,
  createdAt: row.createdAt.toISOString(),
});

const conflict = (existing: DocumentRow | undefined) =>
  knowledgeErrors.create("knowledge.conflict", {
    documentId: existing?.id ?? null,
    latestVersion: existing?.currentVersion ?? 0,
  });

export const findByPath = async (
  db: DrizzleD1Database,
  collectionId: string,
  path: string
): Promise<DocumentRow | undefined> =>
  await db
    .select()
    .from(documents)
    .where(
      and(eq(documents.collectionId, collectionId), eq(documents.path, path))
    )
    .get();

/**
 * Reads `text` for the document at `path` in `collection`, refused as a
 * save would refuse it: over a document's limits, frontmatter that doesn't
 * fit its type, a Playbook record outside a Playbook collection, or, for a
 * memory file, over that file's size limit.
 */
export const checkedText = async (
  env: Env,
  collection: CollectionRow,
  path: string,
  text: string
): Promise<Prepared> => {
  const prepared = prepare(path, text);
  // Records live in the Playbook collection, which only exists once the
  // `playbook` flag is on (playbook.ts): until then no text of a record
  // type is saved anywhere, and code from before record types, which
  // can't read them, still reads everything that is.
  if (isPlaybookRecord(prepared.type) && collection.source !== "playbook") {
    throw invalid([
      `frontmatter.type: a ${prepared.type} record belongs in the Playbook collection`,
    ]);
  }
  await requireFrozenVersions(env, collection, prepared.frozen);
  const memoryFile = await memoryFileOf(collection, path);
  if (memoryFile !== undefined) {
    requireWithinLimit(env, memoryFile, text);
  }
  return prepared;
};

/**
 * Who saves a version: the audit log's actor, and the person the version
 * is by (the author, and the owner of a new document without one in its
 * frontmatter): a person saving themselves, or the one an agent acts for.
 */
export interface Writer {
  actor: AuditActor;
  userId: string;
}

/** A person, saving a version themselves. */
export const personWriter = (person: Identity): Writer => ({
  actor: actorOf(person),
  userId: person.userId,
});

/** A new version of the document at `path` in `collection`. */
export interface Write {
  collection: CollectionRow;
  path: string;
  text: string;
  ifVersion: number;
  message: string | null;
  restoredFrom: number | null;
  /**
   * More statements for the same batch, such as marking the proposal the
   * version comes from approved: they commit with it or not at all.
   */
  also?: BatchItem<"sqlite">[];
}

/**
 * Writes the next version, if the document is still at `ifVersion`
 * (0: it doesn't exist yet). Throws `knowledge.conflict`, with the version
 * it is at, and writes nothing otherwise.
 */
export const writeVersion = async (
  env: Env,
  by: Writer,
  write: Write
): Promise<DocumentSummary> => {
  const { collection, path, text, ifVersion, message, restoredFrom } = write;
  const { also = [] } = write;
  const prepared = await checkedText(env, collection, path, text);
  const db = drizzle(env.KNOWLEDGE);
  const existing = await findByPath(db, collection.id, path);
  if ((existing?.currentVersion ?? 0) !== ifVersion) {
    throw conflict(existing);
  }
  const now = new Date();
  const number = ifVersion + 1;
  const documentId = existing?.id ?? crypto.randomUUID();
  const changes = {
    title: prepared.title,
    type: prepared.type,
    description: prepared.description,
    owner: prepared.owner ?? existing?.owner ?? by.userId,
    tags: JSON.stringify(prepared.tags),
    reviewDate: prepared.reviewDate,
    currentVersion: number,
    updatedAt: now,
  };
  const row: DocumentRow = {
    id: documentId,
    collectionId: collection.id,
    path,
    createdAt: existing?.createdAt ?? now,
    ...changes,
  };
  const entry: AuditEntry = {
    actor: by.actor,
    action:
      restoredFrom === null
        ? "knowledge.document.saved"
        : "knowledge.document.restored",
    target: { type: "document", id: documentId },
    detail: {
      collectionId: collection.id,
      version: number,
      ...(restoredFrom === null ? {} : { restoredFrom }),
    },
  };
  const statements: BatchItem<"sqlite">[] = [
    // The version's primary key is the edit check: a save that got here
    // from the same version first has taken this number.
    db.insert(versions).values({
      documentId,
      number,
      text,
      author: by.userId,
      message,
      restoredFrom,
      createdAt: now,
    }),
    db.delete(sections).where(eq(sections.documentId, documentId)),
    ...inChunks(
      prepared.sections.map((section, position) => ({
        documentId,
        version: number,
        position,
        headings: JSON.stringify(section.headings),
        text: section.text,
      }))
    ).map((chunk) => db.insert(sections).values(chunk)),
    db.delete(links).where(eq(links.fromDocumentId, documentId)),
    ...inChunks(
      prepared.links.map((link) => ({
        fromDocumentId: documentId,
        toCollectionId: collection.id,
        toPath: link.path,
        label: link.label,
      }))
    ).map((chunk) => db.insert(links).values(chunk)),
    outboxed(db, entry),
    ...also,
  ];
  // A new document's row goes first: its version refers to it.
  const document = existing
    ? db
        .update(documents)
        .set(changes)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.currentVersion, ifVersion)
          )
        )
    : db.insert(documents).values(row);
  try {
    await auditedBatch(env, db, [document, ...statements]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(await findByPath(db, collection.id, path));
    }
    throw error;
  }
  return toSummary(row);
};

/**
 * The document with `documentId` and its collection, if it is in one of the
 * `allowed` collections. A malformed ID is one that doesn't exist.
 */
export const readableDocument = async (
  db: DrizzleD1Database,
  allowed: SQL,
  documentId: unknown
): Promise<{ document: DocumentRow; collection: CollectionRow }> => {
  const id = documentIdSchema.safeParse(documentId);
  const found = id.success
    ? await db
        .select({ document: documents, collection: collections })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .where(and(eq(documents.id, id.data), allowed))
        .get()
    : undefined;
  if (!found) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return found;
};

/** Saves a new version of a document, or its first. */
export const saveDocument = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> => {
  const { collectionId, path, text, ifVersion, message } =
    knowledgeErrors.parse("knowledge.invalid", saveInputSchema, input);
  const db = drizzle(env.KNOWLEDGE);
  const collection = await readableCollection(
    db,
    await allowedCollections(env, db, { type: "person", person }),
    collectionId
  );
  requireWritable(env, person, collection);
  return await writeVersion(env, personWriter(person), {
    collection,
    path,
    text,
    ifVersion,
    message: message === undefined || message === "" ? null : message,
    restoredFrom: null,
  });
};

/** Saves an earlier version's text as the next version. */
export const restoreVersion = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> => {
  const { documentId, version, ifVersion } = knowledgeErrors.parse(
    "knowledge.invalid",
    restoreInputSchema,
    input
  );
  const db = drizzle(env.KNOWLEDGE);
  const { document, collection } = await readableDocument(
    db,
    await allowedCollections(env, db, { type: "person", person }),
    documentId
  );
  requireWritable(env, person, collection);
  const restored = await db
    .select({ text: versions.text })
    .from(versions)
    .where(
      and(eq(versions.documentId, document.id), eq(versions.number, version))
    )
    .get();
  if (!restored) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return await writeVersion(env, personWriter(person), {
    collection,
    path: document.path,
    text: restored.text,
    ifVersion,
    message: null,
    restoredFrom: version,
  });
};

/** A document with its current version, or with `version`. */
export const getDocument = async (
  env: Env,
  reader: Reader,
  documentId: unknown,
  version?: unknown
): Promise<DocumentRead> => {
  const number =
    version === undefined
      ? undefined
      : knowledgeErrors.parse("knowledge.invalid", versionInputSchema, version);
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const id = documentIdSchema.safeParse(documentId);
  // The text is read in the same query as the access check, so it is never
  // read from a collection that stopped being readable in between.
  const found = id.success
    ? await db
        .select({
          document: documents,
          collection: collections,
          version: { ...versionSummaryColumns, text: versions.text },
        })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .leftJoin(
          versions,
          and(
            eq(versions.documentId, documents.id),
            eq(versions.number, number ?? documents.currentVersion)
          )
        )
        .where(and(eq(documents.id, id.data), allowed))
        .get()
    : undefined;
  if (!found) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const { document, collection, version: row } = found;
  // Recorded before a missing version is refused: that a version isn't
  // there says something of the document too, so a sensitive one
  // restricts the reader either way.
  const provenance = await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: document.id },
      detail: { read: "document", version: number ?? document.currentVersion },
    },
    collection
  );
  if (row === null) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const read: Version = { ...toVersionSummary(row), text: row.text };
  return { ...toSummary(document), version: read, provenance };
};

/** A page of a collection's documents, in path order. */
export const listDocuments = async (
  env: Env,
  reader: Reader,
  collectionId: unknown,
  options?: unknown
): Promise<DocumentPage> => {
  const { after, limit } = knowledgeErrors.parse(
    "knowledge.invalid",
    listDocumentsOptionsSchema,
    options
  );
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const collection = await readableCollection(db, allowed, collectionId);
  const rows = await db
    .select({ document: documents })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        eq(documents.collectionId, collection.id),
        allowed,
        after === undefined ? undefined : gt(documents.path, after)
      )
    )
    .orderBy(asc(documents.path))
    .limit(limit);
  const provenance = await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      target: { type: "collection", id: collection.id },
      detail: { read: "documents", count: rows.length },
    },
    collection
  );
  return {
    documents: rows.map(({ document }) => toSummary(document)),
    provenance,
  };
};

/** A page of a document's versions, newest first, without their text. */
export const history = async (
  env: Env,
  reader: Reader,
  documentId: unknown,
  options?: unknown
): Promise<HistoryPage> => {
  const { before, limit } = knowledgeErrors.parse(
    "knowledge.invalid",
    historyOptionsSchema,
    options
  );
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const { document, collection } = await readableDocument(
    db,
    allowed,
    documentId
  );
  const rows = await db
    .select(versionSummaryColumns)
    .from(versions)
    .innerJoin(documents, eq(documents.id, versions.documentId))
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        eq(versions.documentId, document.id),
        allowed,
        before === undefined ? undefined : lt(versions.number, before)
      )
    )
    .orderBy(desc(versions.number))
    .limit(limit);
  const provenance = await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: document.id },
      detail: { read: "history", count: rows.length },
    },
    collection
  );
  return { versions: rows.map(toVersionSummary), provenance };
};

const linking = alias(documents, "linking");

/**
 * The documents that link to `document`, in path order after `after`: only
 * those in collections that are `allowed`. Links name paths in their own
 * collection, so a path is enough to page by, and every backlink is in the
 * document's own collection: the read's provenance.
 */
export const backlinkRows = async (
  db: DrizzleD1Database,
  allowed: SQL,
  document: DocumentRow,
  { after, limit }: { after?: string; limit: number }
): Promise<Backlink[]> => {
  const rows = await db
    .select({
      documentId: linking.id,
      collectionId: linking.collectionId,
      path: linking.path,
      title: linking.title,
      label: links.label,
    })
    .from(links)
    .innerJoin(linking, eq(linking.id, links.fromDocumentId))
    .innerJoin(collections, eq(collections.id, linking.collectionId))
    .where(
      and(
        eq(links.toCollectionId, document.collectionId),
        eq(links.toPath, document.path),
        ne(linking.id, document.id),
        // What links are made of already keeps them in one collection; this
        // keeps the provenance true however links come to be written.
        eq(linking.collectionId, document.collectionId),
        allowed,
        after === undefined ? undefined : gt(linking.path, after)
      )
    )
    .orderBy(asc(linking.path))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    documentId: documentIdSchema.parse(row.documentId),
    collectionId: collectionIdSchema.parse(row.collectionId),
  }));
};

/** A page of the documents that link to this one (`backlinkRows`). */
export const backlinks = async (
  env: Env,
  reader: Reader,
  documentId: unknown,
  options?: unknown
): Promise<BacklinkPage> => {
  const page = knowledgeErrors.parse(
    "knowledge.invalid",
    listDocumentsOptionsSchema,
    options
  );
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const { document, collection } = await readableDocument(
    db,
    allowed,
    documentId
  );
  const found = await backlinkRows(db, allowed, document, page);
  const provenance = await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: document.id },
      detail: { read: "backlinks", count: found.length },
    },
    collection
  );
  return { backlinks: found, provenance };
};
