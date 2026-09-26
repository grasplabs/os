import type { AuditEntry } from "@grasp-os/shared/audit";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import {
  documentIdInputSchema,
  documentTypeSchema,
  historyOptionsSchema,
  knowledgeErrors,
  listDocumentsOptionsSchema,
  restoreInputSchema,
  saveInputSchema,
  versionInputSchema,
} from "@grasp-os/shared/knowledge";
import type {
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
import { and, asc, desc, eq, gt, lt, ne } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import { outboxed, sendAuditOutboxNow } from "../audit-outbox.ts";
import { actorOf } from "../audit.ts";
import { isUniqueViolation } from "../db/d1.ts";
import {
  collections,
  documents,
  links,
  sections,
  versions,
} from "../db/knowledge/schema.ts";
import { allowedCollections, recordRead } from "./access.ts";
import type { Reader } from "./access.ts";
import { readableCollection, requireWritable } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import {
  FrontmatterError,
  issueLines,
  parseFrontmatter,
} from "./frontmatter.ts";
import { extractLinks, splitSections } from "./markdown.ts";
import type { Link, Section } from "./markdown.ts";

// Saving a document: its frontmatter is read and checked, its Markdown split
// into sections and its links found, and then one D1 batch (a transaction)
// adds the next version, replaces the sections and links, updates the
// document and stores the audit event. The batch commits whole or not at
// all, and a save from a version that is no longer current writes nothing.

/**
 * Largest document text, in bytes of UTF-8. D1 keeps a row to 2 MB; the
 * version holds the whole text, with room to spare.
 */
export const documentMaxBytes = 1024 * 1024;

/** Most sections one document has. */
export const documentMaxSections = 1000;

/** Most distinct links one document has. */
export const documentMaxLinks = 500;

/** D1 binds at most 100 parameters to one statement. */
const maxBoundParameters = 100;

type DocumentRow = typeof documents.$inferSelect;

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
}

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
  };
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

const toSummary = (row: DocumentRow): DocumentSummary => ({
  id: documentIdSchema.parse(row.id),
  collectionId: collectionIdSchema.parse(row.collectionId),
  path: row.path,
  title: row.title,
  type: documentTypeSchema.parse(row.type),
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

const findByPath = async (
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

/** A new version of the document at `path` in `collection`. */
interface Write {
  collection: CollectionRow;
  path: string;
  text: string;
  ifVersion: number;
  message: string | null;
  restoredFrom: number | null;
}

/**
 * Writes the next version, if the document is still at `ifVersion`
 * (0: it doesn't exist yet). Throws `knowledge.conflict`, with the version
 * it is at, and writes nothing otherwise.
 */
const writeVersion = async (
  env: Env,
  person: Identity,
  write: Write
): Promise<DocumentSummary> => {
  const { collection, path, text, ifVersion, message, restoredFrom } = write;
  const prepared = prepare(path, text);
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
    owner: prepared.owner ?? existing?.owner ?? person.userId,
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
    actor: actorOf(person),
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
      author: person.userId,
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
    await db.batch([document, ...statements]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict(await findByPath(db, collection.id, path));
    }
    throw error;
  }
  await sendAuditOutboxNow(env);
  return toSummary(row);
};

/** `input` as `schema` reads it; `knowledge.invalid` if it doesn't. */
export const parseOrInvalid = <Output>(
  schema: z.ZodType<Output>,
  input: unknown
): Output => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw invalid(issueLines(parsed.error, ""));
  }
  return parsed.data;
};

/**
 * The document with `documentId` and its collection, if it is in one of the
 * `allowed` collections. A malformed ID is one that doesn't exist.
 */
const readableDocument = async (
  db: DrizzleD1Database,
  allowed: SQL,
  documentId: unknown
): Promise<{ document: DocumentRow; collection: CollectionRow }> => {
  const id = documentIdInputSchema.safeParse(documentId);
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
  const { collectionId, path, text, ifVersion, message } = parseOrInvalid(
    saveInputSchema,
    input
  );
  const db = drizzle(env.KNOWLEDGE);
  const collection = await readableCollection(
    db,
    await allowedCollections(env, db, { type: "person", person }),
    collectionId
  );
  requireWritable(person, collection);
  return await writeVersion(env, person, {
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
  const { documentId, version, ifVersion } = parseOrInvalid(
    restoreInputSchema,
    input
  );
  const db = drizzle(env.KNOWLEDGE);
  const { document, collection } = await readableDocument(
    db,
    await allowedCollections(env, db, { type: "person", person }),
    documentId
  );
  requireWritable(person, collection);
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
  return await writeVersion(env, person, {
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
      : parseOrInvalid(versionInputSchema, version);
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const id = documentIdInputSchema.safeParse(documentId);
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
        .innerJoin(
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
  const read: Version = { ...toVersionSummary(row), text: row.text };
  const provenance = await recordRead(env, reader, collection);
  return { ...toSummary(document), version: read, provenance };
};

/** A page of a collection's documents, in path order. */
export const listDocuments = async (
  env: Env,
  reader: Reader,
  collectionId: unknown,
  options?: unknown
): Promise<DocumentPage> => {
  const { after, limit } = parseOrInvalid(listDocumentsOptionsSchema, options);
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
  const provenance = await recordRead(env, reader, collection);
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
  const { before, limit } = parseOrInvalid(historyOptionsSchema, options);
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
  const provenance = await recordRead(env, reader, collection);
  return { versions: rows.map(toVersionSummary), provenance };
};

const linking = alias(documents, "linking");

/**
 * A page of the documents that link to this one, in path order after
 * `after`: only those in collections `reader` may read. Links name paths in
 * their own collection, so a path is enough to page by, and every backlink
 * is in the document's own collection: the read's provenance.
 */
export const backlinks = async (
  env: Env,
  reader: Reader,
  documentId: unknown,
  options?: unknown
): Promise<BacklinkPage> => {
  const { after, limit } = parseOrInvalid(listDocumentsOptionsSchema, options);
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const { document, collection } = await readableDocument(
    db,
    allowed,
    documentId
  );
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
  const provenance = await recordRead(env, reader, collection);
  return {
    backlinks: rows.map((row) => ({
      ...row,
      documentId: documentIdSchema.parse(row.documentId),
      collectionId: collectionIdSchema.parse(row.collectionId),
    })),
    provenance,
  };
};
