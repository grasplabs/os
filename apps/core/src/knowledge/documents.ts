import type {
  AuditActor,
  AuditDetailValue,
  AuditEntry,
} from "@grasp-os/shared/audit";
import { actorOf } from "@grasp-os/shared/audit";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import {
  documentTypeOf,
  historyOptionsSchema,
  isBuiltinDocumentType,
  knowledgeErrors,
  listDocumentsOptionsSchema,
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
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, desc, eq, gt, lt, ne } from "drizzle-orm";
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
import { allowedFor } from "./app-entries.ts";
import type { Allowed } from "./app-entries.ts";
import { readableCollection, requireWritable } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import {
  FrontmatterError,
  frontmatterType,
  parseBaseFields,
  parseRecord,
  savedFields,
} from "./frontmatter.ts";
import type { ParsedRecord } from "./frontmatter.ts";
import { extractLinks, splitSections } from "./markdown.ts";
import type { Link, Section } from "./markdown.ts";
import { memoryFileOf, requireWithinLimit } from "./memory-files.ts";
import {
  declaredTypes,
  keptSetters,
  noDeclaredTypes,
  typeHeld,
} from "./record-types.ts";
import type { DeclaredTypes } from "./record-types.ts";

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
  /** The record types declared for the collection, as it was checked. */
  declared: DeclaredTypes;
}

/**
 * The record types declared for `collectionId` (record-types.ts), read
 * only when one of `types` is one an App declares: a save of a type the
 * platform knows, over one too, needs none.
 */
export const declaredFor = async (
  env: Env,
  collectionId: string,
  types: readonly (string | undefined)[]
): Promise<DeclaredTypes> =>
  types.every((type) => type === undefined || isBuiltinDocumentType(type))
    ? noDeclaredTypes
    : await declaredTypes(env, collectionId);

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
const prepare = (
  path: string,
  text: string,
  declared: DeclaredTypes,
  purge: boolean
): Prepared => {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > documentMaxBytes) {
    throw knowledgeErrors.create("knowledge.too_large", {
      bytes,
      maxBytes: documentMaxBytes,
    });
  }
  let parsed: ParsedRecord;
  try {
    parsed = purge
      ? parseBaseFields(path, text)
      : parseRecord(path, text, declared);
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
  const name =
    type === "skill" && typeof frontmatter.name === "string"
      ? frontmatter.name
      : undefined;
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
    declared,
  };
};

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

/**
 * Reads `text` for the document at `path` in `collection`, refused as a
 * save would refuse it: one to the Grasp skills by anything but their
 * sync (`graspSync`), over a document's limits, frontmatter that doesn't
 * fit its type (a record type as the Apps that declare it for the
 * collection have it, record-types.ts), or, for a memory file, over that
 * file's size limit.
 * `declared` is the collection's record types when the caller read them
 * already; read here otherwise, if the text needs them. A purge's text
 * (`purge`) is checked for the fields every type has only
 * (`parseBaseFields`), whatever its type says.
 */
export const checkedText = async (
  env: Env,
  collection: CollectionRow,
  path: string,
  text: string,
  graspSync = false,
  declared?: DeclaredTypes,
  purge = false
): Promise<Prepared> => {
  // The Grasp skills are the release's (grasp-skills.ts): no save,
  // restore or purge changes them, an admin's neither; the next
  // sync would only put the release's text back.
  if (collection.source === "grasp" && !graspSync) {
    throw knowledgeErrors.create("knowledge.read_only");
  }
  const prepared = prepare(
    path,
    text,
    declared ??
      (await declaredFor(env, collection.id, [frontmatterType(path, text)])),
    purge
  );
  const memoryFile = await memoryFileOf(collection, path);
  if (memoryFile !== undefined) {
    requireWithinLimit(env, memoryFile, text);
  }
  return prepared;
};

/**
 * Who saves a version: the audit log's actor, and the person the version
 * is by (the author, and the owner of a new document without one in its
 * frontmatter): a person saving themselves, or the one an agent or App
 * acts for. `detail` goes into the save's audit event: for an App, the
 * person it acted for, how (interactive or a workflow run) and its
 * version, which its actor doesn't name. `admin` is set only for an admin
 * saving themselves, never for an agent or App acting for one.
 */
export interface Writer {
  actor: AuditActor;
  userId: string;
  detail?: Record<string, AuditDetailValue>;
  admin?: boolean;
}

/** A person, saving a version themselves. */
export const personWriter = (person: Identity): Writer => ({
  actor: actorOf(person),
  userId: person.userId,
  admin: isAdmin(person.role),
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
   * More statements for the same batch, such as a purge's rewrite of the
   * current version: they commit with it or not at all.
   */
  also?: BatchItem<"sqlite">[];
  /** Set only by the sync of the Grasp skills, their one writer. */
  graspSync?: true;
  /**
   * Kept fields this version sets instead of keeping them, by name: only
   * the method a record type's declaration names for them (knowledge/
   * records.ts).
   */
  sets?: Record<string, unknown>;
  /**
   * Checked last, just before the batch is sent, with nothing awaited in
   * between: throws to refuse the write, such as a delegate's context that
   * became restricted while the save was being prepared.
   */
  lastCheck?: () => Promise<void>;
  /**
   * Set only by a purge (purge.ts): removing personal data comes before a
   * record's type and its kept fields, so its text is checked only for
   * the fields every type has and a document's limits (`parseBaseFields`).
   */
  purge?: true;
}

/** A frontmatter field's value, if it has one. */
const fieldOf = (frontmatter: object | undefined, field: string): unknown =>
  frontmatter === undefined
    ? undefined
    : Object.entries(frontmatter).find(([key]) => key === field)?.[1];

/** A field's value as JSON, comparable whatever the order of its keys. */
const comparable = (value: unknown): string | undefined =>
  value === undefined ? undefined : canonicalJson(z.json().parse(value));

/** The fields a record of `type` keeps, by its declarations (record-types.ts). */
export const keptNames = (type: string, declared: DeclaredTypes): string[] => [
  ...new Set(keptSetters(declared, type).keys()),
];

/** What `requireFieldsKept` compares: a version, and the one it goes over. */
interface KeptCheck {
  existing: DocumentRow | undefined;
  ifVersion: number;
  path: string;
  text: string;
  type: DocumentType;
  collection: CollectionRow;
  declared: DeclaredTypes;
  /** A purge's: it rewrites kept fields too, personal data coming first. */
  purge: boolean;
  /** An admin's own save (`Writer.admin`). */
  byAdmin: boolean | undefined;
}

/**
 * Refuses with `knowledge.invalid` a version that changes a kept field
 * (record-types.ts) of its type, unless the write `sets` it: a version
 * that doesn't set one has it as the version it goes over has it, when
 * that version is of the same type, and doesn't have it otherwise. Both
 * are read as their texts have them, checked against nothing, so a
 * version that no longer fits its type (after its schema changed) keeps
 * them all the same. The version it goes over is the one the write's
 * batch requires is still current, so nothing saved in between is
 * compared against. A version of another type than the one it goes over
 * is refused too while that one has a kept field its write doesn't set:
 * otherwise a round trip through another type would drop the field. A
 * write sets a field of the type it goes over only when the same App
 * owns that field in both types: another App's method sets its own
 * type's field of that name, never this one.
 *
 * While nobody declares the type it goes over, which fields it keeps
 * isn't known, so a record of it stays of it, whatever the write sets.
 * That is for as long as an App still has the type (`typeHeld`): its
 * current version waits for approval. Once no
 * App has it (its owner may no longer write the collection, or no longer
 * declares it), nothing would ever declare it again for its owner, and an
 * admin makes the record a plain `doc` by hand. Returns what the save's
 * audit event says of that: the type such a save takes the record out of
 * (`releasedType`), and nothing for any other save.
 */
const requireFieldsKept = async (
  env: Env,
  db: DrizzleD1Database,
  check: KeptCheck,
  sets: Record<string, unknown> = {}
): Promise<{ releasedType?: string }> => {
  const { existing, ifVersion, path, text, type, declared, purge } = check;
  if (purge) {
    return {};
  }
  const before = existing
    ? await db
        .select({ text: versions.text })
        .from(versions)
        .where(
          and(
            eq(versions.documentId, existing.id),
            eq(versions.number, ifVersion)
          )
        )
        .get()
    : undefined;
  const savedRaw =
    before === undefined ? undefined : savedFields(path, before.text);
  const nowRaw = savedFields(path, text);
  // The kept fields of the version's own type, each carried over only
  // from a version of that same type (its same owner's): text of any other
  // type (a `doc`, or another App's type with a field of the same name)
  // carries nothing, and the field is then absent unless its method sets it.
  const sameType = savedRaw?.type === type;
  const declaredProblems = [...keptSetters(declared, type).keys()].flatMap(
    (field) => {
      const was = sameType ? fieldOf(savedRaw?.fields, field) : undefined;
      const kept = Object.hasOwn(sets, field) ? fieldOf(sets, field) : was;
      return comparable(fieldOf(nowRaw?.fields, field)) === comparable(kept)
        ? []
        : [
            `frontmatter.${field}: only the method its record type gives it to changes it; a save keeps the version before's`,
          ];
    }
  );
  // And those of the type it goes over, when that is another: a version
  // of another type (a `doc`, say) would drop them, and one of the type
  // again after it would then set them afresh. So a record whose type
  // keeps fields doesn't change type by hand while it has any of them.
  const previous = savedRaw?.type;
  const leaves = previous !== undefined && !sameType;
  // The write's `sets` are by the new type's setters: they set a field
  // of the type it goes over only where that field is the same App's in
  // both, never another App's field of the same name.
  const setters = keptSetters(declared, type);
  const droppedProblems = leaves
    ? [...keptSetters(declared, previous)].flatMap(([field, { app }]) =>
        fieldOf(savedRaw?.fields, field) === undefined ||
        (Object.hasOwn(sets, field) && setters.get(field)?.app === app)
          ? []
          : [
              `frontmatter.type: a ${previous} keeps its ${field}, which only the method its record type gives it to changes, so it stays a ${previous}`,
            ]
      )
    : [];
  // A type nobody declares now (record-types.ts) has no kept fields to
  // read here, though its records may hold some. A version of another
  // type over one would drop them unseen, and one of the type again, once
  // it is declared again, would set them afresh.
  const undeclared =
    leaves && !isBuiltinDocumentType(previous) && !declared.has(previous);
  // But for an admin making it a plain doc once no App has the type any
  // more: read only then, by the claim's key, and again just before the
  // write (`requireStillReleased`).
  const released =
    undeclared &&
    check.byAdmin === true &&
    type === "doc" &&
    !(await typeHeld(env, check.collection.id, previous));
  const undeclaredProblems =
    undeclared && !released
      ? [
          `frontmatter.type: no App declares ${previous} for this collection now, so which fields a ${previous} keeps isn't known, and it stays a ${previous}; once no App has the type any more, an admin can make it a plain doc`,
        ]
      : [];
  const problems = [
    ...declaredProblems,
    ...droppedProblems,
    ...undeclaredProblems,
  ];
  if (problems.length > 0) {
    throw invalid(problems);
  }
  return released ? { releasedType: previous } : {};
};

/**
 * Refuses with `knowledge.invalid` a save that takes a record out of a
 * type no App had (`releasedType`, from `requireFieldsKept`) when an App
 * has it now: another App may have claimed it while the save was being
 * prepared, and the record is then that App's to keep. Read last, just
 * before the write's batch, as an App's write checks its context
 * (`Write.lastCheck`). The claim is in core's database and the document
 * in Knowledge's, which share no transaction, so a claim that lands
 * between this read and the batch is not seen: that takes an admin
 * converting the record at the very moment another App, granted the
 * collection and approved, first saves or reads a record of the type. The
 * save is audited with `releasedType` either way.
 */
const requireStillReleased = async (
  env: Env,
  collectionId: string,
  releasedType: string | undefined
): Promise<void> => {
  if (
    releasedType !== undefined &&
    (await typeHeld(env, collectionId, releasedType))
  ) {
    throw invalid([
      `frontmatter.type: an App has ${releasedType} for this collection now, so it stays a ${releasedType}`,
    ]);
  }
};

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
  const { also = [], graspSync = false } = write;
  const db = drizzle(env.KNOWLEDGE);
  const existing = await findByPath(db, collection.id, path);
  // The types of both the new version and the one it goes over: a kept
  // field of either is kept.
  const declared = await declaredFor(env, collection.id, [
    frontmatterType(path, text),
    existing?.type,
  ]);
  const prepared = await checkedText(
    env,
    collection,
    path,
    text,
    graspSync,
    declared,
    write.purge === true
  );
  if ((existing?.currentVersion ?? 0) !== ifVersion) {
    throw conflict(existing);
  }
  const released = await requireFieldsKept(
    env,
    db,
    {
      existing,
      ifVersion,
      path,
      text,
      type: prepared.type,
      collection,
      declared,
      purge: write.purge === true,
      byAdmin: by.admin,
    },
    write.sets
  );
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
      ...by.detail,
      collectionId: collection.id,
      version: number,
      ...(restoredFrom === null ? {} : { restoredFrom }),
      // An admin made a record of a type no App has any more a plain doc.
      ...released,
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
  await requireStillReleased(env, collection.id, released.releasedType);
  await write.lastCheck?.();
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
 * The document with `documentId` and its collection, if it is one of the
 * `allowed` documents. A malformed ID is one that doesn't exist.
 */
export const readableDocument = async (
  db: DrizzleD1Database,
  allowed: Allowed,
  documentId: unknown
): Promise<{ document: DocumentRow; collection: CollectionRow }> => {
  const id = documentIdSchema.safeParse(documentId);
  const found = id.success
    ? await db
        .select({ document: documents, collection: collections })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .where(and(eq(documents.id, id.data), allowed.documents()))
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
    await allowedFor(env, db, { type: "person", person }),
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
  const allowed = await allowedFor(env, db, reader);
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
        .where(and(eq(documents.id, id.data), allowed.documents()))
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
  const allowed = await allowedFor(env, db, reader, collectionId);
  const collection = await readableCollection(
    db,
    allowed.collections,
    collectionId
  );
  const rows = await db
    .select({ document: documents })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        eq(documents.collectionId, collection.id),
        allowed.documents(),
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
  const allowed = await allowedFor(env, db, reader);
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
        allowed.documents(),
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
 * those that are `allowed`. Links name paths in their own
 * collection, so a path is enough to page by, and every backlink is in the
 * document's own collection: the read's provenance.
 */
export const backlinkRows = async (
  db: DrizzleD1Database,
  allowed: Allowed,
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
        allowed.documents(linking.path),
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
  const allowed = await allowedFor(env, db, reader);
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
