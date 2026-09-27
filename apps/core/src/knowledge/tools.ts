import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import {
  documentTypeOf,
  followMaxEntries,
  knowledgeErrors,
  readOptionsSchema,
} from "@grasp-os/shared/knowledge";
import type {
  CatalogCollection,
  CatalogSkill,
  DocumentLink,
  FollowResult,
  KnowledgeCatalog,
  KnowledgeRead,
  SkillFile,
} from "@grasp-os/shared/knowledge";
import { and, asc, eq, gte, lt, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import {
  collections,
  documents,
  links,
  sections,
} from "../db/knowledge/schema.ts";
import { allowedCollections, noteProvenance } from "./access.ts";
import type { Reader } from "./access.ts";
import {
  backlinkRows,
  documentMaxLinks,
  getDocument,
  readableDocument,
  toSummary,
} from "./documents.ts";

// The agent's Knowledge tools (Code Mode: a typed API it filters in code):
// a small catalog always in its context, then search (search.ts), read and
// follow on demand. They read through the same access check as every other
// read (`allowedCollections`), and every read but the catalog goes through
// `noteProvenance`: marked with where it came from, restricting an App or
// agent's context when it is sensitive, and recorded in the audit log.

/**
 * The catalog is in an agent's context on every turn, so it has a fixed
 * budget: 16,000 characters of its JSON, about 4,000 tokens at the usual
 * 4 characters per token. Every description is cut to
 * {@link catalogDescriptionMaxLength} characters, so no one entry takes the
 * budget; collections come first, as the agent's way in, then skills, each
 * by name, until the next entry doesn't fit. What is left out is still
 * found by search, and `truncated` says so.
 */
export const catalogMaxCharacters = 16_000;

const catalogDescriptionMaxLength = 200;

/**
 * Most collections, and most skills, the catalog reads: more than its
 * budget holds, so a large library costs no more than the entries that fit.
 */
const catalogMaxEntries = 200;

/**
 * `text` cut to `max` characters, marked when cut. By code points, so a cut
 * never leaves half a surrogate pair; one through an emoji sequence only
 * shortens the emoji.
 */
const cut = (text: string, max: number): string => {
  // oxlint-disable-next-line typescript/no-misused-spread -- see above
  const characters = [...text];
  return characters.length <= max
    ? text
    : `${characters.slice(0, max - 1).join("")}…`;
};

/**
 * The first of `entries` that fit in `budget` characters of JSON (each
 * with a comma), the characters left, and whether all of them fit.
 */
const fitting = <Entry>(
  entries: Entry[],
  budget: number
): { fits: Entry[]; left: number; all: boolean } => {
  const fits: Entry[] = [];
  let left = budget;
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1;
    if (size > left) {
      return { fits, left, all: false };
    }
    fits.push(entry);
    left -= size;
  }
  return { fits, left, all: true };
};

/**
 * The collections `reader` may read, and the skills in them, within
 * {@link catalogMaxCharacters}. Only skills of collections that aren't
 * sensitive: the catalog reaches the agent's context without a read, so it
 * holds nothing that would have to put it in restricted mode. A sensitive
 * collection's skills are found by search, which does. Nor is it recorded:
 * it names what may be read, and reading any of it is recorded.
 */
export const catalog = async (
  env: Env,
  reader: Reader
): Promise<KnowledgeCatalog> => {
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const collectionRows = await db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      sensitive: collections.sensitive,
    })
    .from(collections)
    .where(allowed)
    .orderBy(asc(collections.name), asc(collections.id))
    .limit(catalogMaxEntries + 1);
  const skillRows = await db
    .select({
      documentId: documents.id,
      collectionId: documents.collectionId,
      name: documents.title,
      description: documents.description,
    })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        eq(documents.type, "skill"),
        eq(collections.sensitive, false),
        allowed
      )
    )
    .orderBy(asc(documents.title), asc(documents.id))
    .limit(catalogMaxEntries + 1);
  const listed: CatalogCollection[] = collectionRows
    .slice(0, catalogMaxEntries)
    .map((row) => ({
      id: collectionIdSchema.parse(row.id),
      name: row.name,
      description: cut(row.description, catalogDescriptionMaxLength),
      sensitive: row.sensitive,
    }));
  const skills: CatalogSkill[] = skillRows
    .slice(0, catalogMaxEntries)
    .map((row) => ({
      documentId: documentIdSchema.parse(row.documentId),
      collectionId: collectionIdSchema.parse(row.collectionId),
      name: row.name,
      description: cut(row.description, catalogDescriptionMaxLength),
    }));
  const envelope = JSON.stringify({
    collections: [],
    skills: [],
    truncated: false,
  }).length;
  const first = fitting(listed, catalogMaxCharacters - envelope);
  const then = fitting(skills, first.left);
  return {
    collections: first.fits,
    skills: then.fits,
    truncated:
      !(first.all && then.all) ||
      collectionRows.length > catalogMaxEntries ||
      skillRows.length > catalogMaxEntries,
  };
};

const headingsSchema = z.array(z.string());

/**
 * One section of a document (a search hit's `section`), without the rest
 * of it, or the whole document, at its current version.
 */
export const read = async (
  env: Env,
  reader: Reader,
  documentId: unknown,
  options?: unknown
): Promise<KnowledgeRead> => {
  const { section } = knowledgeErrors.parse(
    "knowledge.invalid",
    readOptionsSchema,
    options
  );
  if (section === undefined) {
    const { version, provenance, ...summary } = await getDocument(
      env,
      reader,
      documentId
    );
    return { ...summary, section: null, text: version.text, provenance };
  }
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const id = documentIdSchema.safeParse(documentId);
  // The section is read in the same query as the access check, as a whole
  // document is (`getDocument`).
  const found = id.success
    ? await db
        .select({
          document: documents,
          collection: collections,
          section: { headings: sections.headings, text: sections.text },
        })
        .from(documents)
        .innerJoin(collections, eq(collections.id, documents.collectionId))
        .leftJoin(
          sections,
          and(
            eq(sections.documentId, documents.id),
            eq(sections.position, section)
          )
        )
        .where(and(eq(documents.id, id.data), allowed))
        .get()
    : undefined;
  if (!found) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const { document, collection, section: row } = found;
  // Recorded before a missing section is refused, as a missing version is:
  // how many sections a document has says something of it too.
  const provenance = await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: document.id },
      detail: {
        read: "section",
        version: document.currentVersion,
        section,
      },
    },
    collection
  );
  if (row === null) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return {
    ...toSummary(document),
    section: {
      position: section,
      headings: headingsSchema.parse(JSON.parse(row.headings)),
    },
    text: row.text,
    provenance,
  };
};

const target = alias(documents, "target");

/**
 * The first path after every path in the folder `folder` (which ends in
 * `/`): its `/` raised to `0`, the next character. SQLite compares text by
 * its bytes, so the folder's paths are those from `folder` up to this one.
 */
const pastFolder = (folder: string): string => `${folder.slice(0, -1)}0`;

/**
 * Where a document leads: the documents its links name, the documents
 * that link to it, and, for a skill, the documents in its folder and
 * below, which it refers to by relative path (a skill at the top of its
 * collection has the whole collection as its folder). All of them are in
 * the document's own collection, so its provenance is that collection's.
 */
export const follow = async (
  env: Env,
  reader: Reader,
  documentId: unknown
): Promise<FollowResult> => {
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedCollections(env, db, reader);
  const { document, collection } = await readableDocument(
    db,
    allowed,
    documentId
  );
  const linkRows = await db
    .select({
      path: links.toPath,
      label: links.label,
      documentId: target.id,
      title: target.title,
    })
    .from(links)
    .leftJoin(
      target,
      and(
        eq(target.collectionId, links.toCollectionId),
        eq(target.path, links.toPath)
      )
    )
    .where(
      and(
        eq(links.fromDocumentId, document.id),
        // Links name paths in their own collection, which is readable.
        eq(links.toCollectionId, document.collectionId)
      )
    )
    .orderBy(asc(links.toPath))
    // All of them: a save keeps a document to this many.
    .limit(documentMaxLinks);
  const linked: DocumentLink[] = linkRows.map((row) => ({
    ...row,
    documentId:
      row.documentId === null ? null : documentIdSchema.parse(row.documentId),
  }));
  // One more than it returns of each, to tell whether there are more.
  const linking = await backlinkRows(db, allowed, document, {
    limit: followMaxEntries + 1,
  });
  const backlinks = linking.slice(0, followMaxEntries);
  let truncated = linking.length > followMaxEntries;
  let files: SkillFile[] = [];
  if (document.type === "skill") {
    const folder = document.path.slice(0, document.path.lastIndexOf("/") + 1);
    const fileRows = await db
      .select({ document: documents })
      .from(documents)
      .innerJoin(collections, eq(collections.id, documents.collectionId))
      .where(
        and(
          eq(documents.collectionId, document.collectionId),
          ne(documents.id, document.id),
          folder === ""
            ? undefined
            : and(
                gte(documents.path, folder),
                lt(documents.path, pastFolder(folder))
              ),
          allowed
        )
      )
      .orderBy(asc(documents.path))
      .limit(followMaxEntries + 1);
    truncated ||= fileRows.length > followMaxEntries;
    files = fileRows.slice(0, followMaxEntries).map(({ document: row }) => ({
      documentId: documentIdSchema.parse(row.id),
      path: row.path,
      title: row.title,
      type: documentTypeOf(row.type),
      description: row.description,
    }));
  }
  const provenance = await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: document.id },
      detail: {
        read: "follow",
        links: linked.length,
        backlinks: backlinks.length,
        files: files.length,
      },
    },
    collection
  );
  return { links: linked, backlinks, files, truncated, provenance };
};
