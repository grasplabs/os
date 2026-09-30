import { delegateActorOf } from "@grasp-os/shared/audit";
import type { AuditActor, AuditDetailValue } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId, CollectionId, PermissionId } from "@grasp-os/shared/ids";
import {
  knowledgeErrors,
  listRecordsOptionsSchema,
  recordSaveSchema,
} from "@grasp-os/shared/knowledge";
import type {
  DocumentSummary,
  RecordPage,
  RecordRead,
  RecordSummary,
} from "@grasp-os/shared/knowledge";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import { and, asc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { stringify } from "yaml";

import type { Person } from "../app-access.ts";
import { memberRole, teamsOf } from "../auth/identity.ts";
import { collections, documents, versions } from "../db/knowledge/schema.ts";
import { authorize } from "../permissions.ts";
import { isRestricted } from "../restricted.ts";
import { noteProvenance } from "./access.ts";
import type { Reader } from "./access.ts";
import { allowedFor } from "./app-entries.ts";
import {
  isWritable,
  readableCollection,
  requireWritable,
} from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import {
  declaredFor,
  findByPath,
  getDocument,
  keptNames,
  toSummary,
  writeVersion,
} from "./documents.ts";
import type { DocumentRow, Writer } from "./documents.ts";
import {
  FrontmatterError,
  frontmatterType,
  parseRecord,
  savedFields,
} from "./frontmatter.ts";
import { keptSetters } from "./record-types.ts";
import type { DeclaredTypes } from "./record-types.ts";

// Records: documents read and written as data, for code with no YAML
// parser (an App's server code, through its collection stubs,
// knowledge/app-binding.ts). A record is its frontmatter, whose `type`
// picks the schema that checks it (one the platform knows, or one an App
// declares for the collection, record-types.ts), and the Markdown after
// it. Saved through the same pipeline as any document (documents.ts):
// with versions, search, links, purges and audit events, and refused as
// any save is.
//
// An App writes records for the person whose call it runs in, as a
// delegate: only under a permission to write the collection, only what
// that person may do themselves, and never from a context that read
// restricted data, which it could pass on into a collection that others
// read.

/**
 * Who saves a record: the person whose rights apply, the audit actor, and
 * for an App or agent, what its audit events add (`Writer`'s `detail`).
 */
export interface RecordWriter {
  person: Person;
  actor: AuditActor;
  detail?: Record<string, AuditDetailValue>;
  /** Checked again just before each write's batch (`Write`'s `lastCheck`). */
  lastCheck?: () => Promise<void>;
}

/** What each write of `writer` checks last, just before its batch. */
export const lastCheckOf = ({
  lastCheck,
}: RecordWriter): { lastCheck?: () => Promise<void> } =>
  lastCheck === undefined ? {} : { lastCheck };

/** Who a writer's versions are by, and what their audit events say. */
export const versionWriter = ({
  person,
  actor,
  detail,
}: RecordWriter): Writer => ({
  actor,
  userId: person.userId,
  ...(detail === undefined ? {} : { detail }),
});

/** The text of `record`: its frontmatter, then its Markdown. */
export const recordText = (
  record: Record<string, unknown>,
  body: string
): string => `---\n${stringify(record)}---\n${body}`;

/** The text of version `number` of `documentId`, if it has one. */
export const versionText = async (
  env: Env,
  documentId: string,
  number: number
): Promise<string | undefined> => {
  const row = await drizzle(env.KNOWLEDGE)
    .select({ text: versions.text })
    .from(versions)
    .where(
      and(eq(versions.documentId, documentId), eq(versions.number, number))
    )
    .get();
  return row?.text;
};

/**
 * The person an App or agent writes the collection `collectionId` for
 * (`authority`), in `context`: only while `permissionId` lets it write
 * the collection, that person is still a member, and the context hasn't
 * read restricted data (`permission.restricted`), which a write could
 * pass on to whoever reads the collection. Their own rights apply on top
 * (`requireWritable`, as each write checks).
 */
export const delegateWriter = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  permissionId: PermissionId,
  collectionId: CollectionId
): Promise<RecordWriter> => {
  await authorize(
    env,
    authority,
    { type: "collection", collectionId },
    "write",
    permissionId
  );
  const requireUnrestricted = async (): Promise<void> => {
    if (await isRestricted(env, authority, context)) {
      throw permissionErrors.create("permission.restricted");
    }
  };
  await requireUnrestricted();
  const userId = authority.onBehalfOf;
  const role = await memberRole(env.DB, userId);
  if (!role) {
    throw permissionErrors.create("permission.person_inactive");
  }
  return {
    person: { userId, role, teams: await teamsOf(env.DB, userId) },
    actor: delegateActorOf(authority),
    // Again just before the batch. The save's payload was fixed when App
    // code called it, so a sensitive read finishing meanwhile can't be in
    // it: this is defence in depth.
    lastCheck: requireUnrestricted,
    // The App actor doesn't name the person or the version; a workflow
    // run's write (`mode: "workflow"`) acts for its starter, or for the
    // App's owner when a trigger started it.
    detail: {
      onBehalfOf: userId,
      mode: authority.mode,
      ...(authority.appVersion === undefined
        ? {}
        : { appVersion: authority.appVersion }),
    },
  };
};

/** The collection `collectionId`, if it exists. */
const storedCollection = async (
  env: Env,
  collectionId: CollectionId
): Promise<CollectionRow | undefined> =>
  await drizzle(env.KNOWLEDGE)
    .select()
    .from(collections)
    .where(eq(collections.id, collectionId))
    .get();

/** Which method of which App a write runs in, when an App's code writes. */
export interface Setter {
  app: AppId;
  method: string;
}

/**
 * The kept fields of a `type` record that `setter` sets (record-types.ts),
 * as `record` has them: those whose declaration names its method, and
 * that `record` includes. One it leaves out is kept as it was.
 */
const setBy = (
  declared: DeclaredTypes,
  type: string,
  record: Record<string, unknown>,
  setter: Setter | undefined
): Record<string, unknown> => {
  if (setter === undefined) {
    return {};
  }
  return Object.fromEntries(
    [...keptSetters(declared, type)]
      .filter(
        ([field, { app, method }]) =>
          app === setter.app &&
          method === setter.method &&
          Object.hasOwn(record, field)
      )
      .map(([field]) => [field, record[field]])
  );
};

/** `text` read as a record, or undefined when it doesn't fit its type. */
const readable = (
  path: string,
  text: string,
  declared: DeclaredTypes
): ReturnType<typeof parseRecord> | undefined => {
  try {
    return parseRecord(path, text, declared);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      return undefined;
    }
    throw error;
  }
};

/**
 * Writes a record (`recordSaveSchema`) to `collection` as `writer`, from
 * `ifVersion` of its path, through the save pipeline. The kept fields its
 * type declares that `setter` sets are as `record` has them; every other
 * kept field that `record` leaves out, of its type or of the version it
 * goes over, is kept as that version has it, and one it changes refuses
 * the save (documents.ts, `requireFieldsKept`).
 */
export const writeRecord = async (
  env: Env,
  writer: RecordWriter,
  collection: CollectionRow,
  input: unknown,
  setter?: Setter
): Promise<DocumentSummary> => {
  const { path, ifVersion, record, body, message } = knowledgeErrors.parse(
    "knowledge.invalid",
    recordSaveSchema,
    input
  );
  requireWritable(env, writer.person, collection);
  const existing =
    ifVersion === 0
      ? undefined
      : await findByPath(drizzle(env.KNOWLEDGE), collection.id, path);
  // Only from the current version: from any other, the save refuses it as
  // a conflict, and nothing older is carried into it.
  const previous =
    existing?.currentVersion === ifVersion
      ? await versionText(env, existing.id, ifVersion)
      : undefined;
  const declared = await declaredFor(env, collection.id, [
    record.type,
    existing?.type,
  ]);
  const sets = setBy(declared, record.type, record, setter);
  // As the version it goes over has them, whether or not that version
  // still fits its type.
  const saved =
    previous === undefined ? undefined : savedFields(path, previous);
  // Only from a version of the same type (documents.ts,
  // `requireFieldsKept`), and only those `record` leaves out.
  const kept = Object.fromEntries(
    (saved?.type === record.type
      ? keptNames(record.type, declared)
      : []
    ).flatMap((field) =>
      Object.hasOwn(sets, field) ||
      Object.hasOwn(record, field) ||
      saved?.fields[field] === undefined
        ? []
        : [[field, saved.fields[field]]]
    )
  );
  return await writeVersion(env, versionWriter(writer), {
    collection,
    path,
    text: recordText({ ...record, ...kept }, body),
    ifVersion,
    message: message === undefined || message === "" ? null : message,
    restoredFrom: null,
    sets,
    ...lastCheckOf(writer),
  });
};

/**
 * Saves a record to the collection `collectionId`, by an App or agent for
 * the person `authority` names, under the permission `permissionId` (see
 * `delegateWriter`), from the App's method `setter` runs in, if any (see
 * `writeRecord`). The version is that person's, and the audit log names
 * the App or agent. `knowledge.not_found` for a collection that doesn't
 * exist.
 */
export const saveRecordAsDelegate = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  permissionId: PermissionId,
  collectionId: CollectionId,
  input: unknown,
  setter?: Setter
): Promise<DocumentSummary> => {
  const writer = await delegateWriter(
    env,
    authority,
    context,
    permissionId,
    collectionId
  );
  const collection = await storedCollection(env, collectionId);
  if (!collection) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return await writeRecord(env, writer, collection, input, setter);
};

/**
 * Whether `saveRecordAsDelegate` would write for the person `authority`
 * names, under `permissionId`, in `context`: the same checks
 * (`delegateWriter`, then `requireWritable` on the collection), for
 * showing only the changes core would take. Writes nothing, and records
 * nothing: each write is checked and recorded as it is made.
 */
export const canWriteAsDelegate = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  permissionId: PermissionId,
  collectionId: CollectionId
): Promise<boolean> => {
  let person: Person;
  try {
    ({ person } = await delegateWriter(
      env,
      authority,
      context,
      permissionId,
      collectionId
    ));
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
  const collection = await storedCollection(env, collectionId);
  return collection !== undefined && isWritable(env, person, collection);
};

/**
 * A document as `reader` may read it (`getDocument`), with its frontmatter
 * as data (`record`: its type, and the fields its type's schema reads,
 * defaults filled in), and the Markdown after it (`body`): how code with
 * no YAML parser reads a record, and saves it back (`writeRecord`).
 * Refused with `knowledge.invalid`, saying why, when the text doesn't fit
 * its type now (under another release's schemas, or another version of
 * the App that declares it).
 */
export const getRecord = async (
  env: Env,
  reader: Reader,
  documentId: unknown,
  version?: unknown
): Promise<RecordRead> => {
  const read = await getDocument(env, reader, documentId, version);
  // By the type the version read says, which an earlier one may not share
  // with the document now.
  const declared = await declaredFor(env, read.collectionId, [
    frontmatterType(read.path, read.version.text),
  ]);
  try {
    const { type, frontmatter, body } = parseRecord(
      read.path,
      read.version.text,
      declared
    );
    return { ...read, record: { type, ...frontmatter }, body };
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw knowledgeErrors.create("knowledge.invalid", {
        issues: error.issues,
      });
    }
    throw error;
  }
};

/**
 * The record `text` holds, as `document`'s current version, or
 * `undefined` when there is none or it doesn't fit its type now (see
 * `getRecord`).
 */
const recordOf = (
  document: DocumentRow,
  text: string | null,
  declared: DeclaredTypes
): RecordSummary | undefined => {
  if (text === null) {
    return undefined;
  }
  const parsed = readable(document.path, text, declared);
  return parsed === undefined
    ? undefined
    : {
        ...toSummary(document),
        record: { type: parsed.type, ...parsed.frontmatter },
        body: parsed.body,
      };
};

/**
 * A page of the collection `collectionId`'s documents (of `type`, if
 * given), in path order, each read as `getRecord` reads its current
 * version, in one read: one access check, and one read in the audit log
 * for the page, naming the documents it read. How code that needs many
 * records reads them without a read, and an audit event, for each.
 */
export const listRecords = async (
  env: Env,
  reader: Reader,
  collectionId: unknown,
  options?: unknown
): Promise<RecordPage> => {
  const { after, limit, type } = knowledgeErrors.parse(
    "knowledge.invalid",
    listRecordsOptionsSchema,
    options
  );
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedFor(env, db, reader, collectionId);
  const collection = await readableCollection(
    db,
    allowed.collections,
    collectionId
  );
  // The documents of the page, or of the rest of the collection, after
  // the path `from`.
  const listed = (from: string | undefined) =>
    and(
      eq(documents.collectionId, collection.id),
      allowed.documents(),
      from === undefined ? undefined : gt(documents.path, from),
      type === undefined ? undefined : eq(documents.type, type)
    );
  // The text is read in the same query as the access check, as
  // `getDocument` reads it.
  const rows = await db
    .select({ document: documents, text: versions.text })
    .from(documents)
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .leftJoin(
      versions,
      and(
        eq(versions.documentId, documents.id),
        eq(versions.number, documents.currentVersion)
      )
    )
    .where(listed(after))
    .orderBy(asc(documents.path))
    .limit(limit);
  const last = rows.at(-1);
  // Whether another page follows, only after a full one: by ID alone, so
  // nothing is read that this page's audit event doesn't name.
  const more =
    rows.length === limit && last !== undefined
      ? await db
          .select({ id: documents.id })
          .from(documents)
          .innerJoin(collections, eq(collections.id, documents.collectionId))
          .where(listed(last.document.path))
          .limit(1)
          .get()
      : undefined;
  const provenance = await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      target: { type: "collection", id: collection.id },
      // At most `recordPageMaxLimit` (20) and the collection: they fit the
      // event's provenance.
      documentIds: rows.map(({ document }) => document.id),
      detail: { read: "records", count: rows.length },
    },
    collection
  );
  const declared = await declaredFor(
    env,
    collection.id,
    rows.map(({ document }) => document.type)
  );
  const records: RecordSummary[] = [];
  const unreadable: DocumentSummary[] = [];
  for (const { document, text } of rows) {
    const record = recordOf(document, text, declared);
    if (record === undefined) {
      unreadable.push(toSummary(document));
    } else {
      records.push(record);
    }
  }
  return {
    records,
    unreadable,
    next: more === undefined || last === undefined ? null : last.document.path,
    provenance,
  };
};
