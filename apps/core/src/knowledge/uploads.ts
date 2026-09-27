import { actorOf, auditActorSchema } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import {
  authErrors,
  featureErrors,
  internalErrors,
  requestErrors,
} from "@grasp-os/shared/errors";
import { collectionIdSchema, documentIdSchema } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  uploadErrors,
  uploadExtensionOf,
  uploadInputSchema,
  uploadMaxBytes,
  uploadMediaTypeSchema,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import type {
  Upload,
  UploadExtension,
  UploadMediaType,
} from "@grasp-os/shared/uploads";
import { and, asc, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { stringify } from "yaml";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import { identify } from "../auth/identity.ts";
import {
  collections,
  uploadCleanups,
  uploads,
} from "../db/knowledge/schema.ts";
import { errorResponse } from "../errors.ts";
import { featureEnabled, requireFeature } from "../features.ts";
import { runEngine } from "../workflows/engine.ts";
import { allowedCollections, noteProvenance } from "./access.ts";
import { readableCollection, requireWritable } from "./collections.ts";
import { findByPath, writeVersion } from "./documents.ts";
import type { Extractor } from "./extract.ts";

// Files uploaded into Knowledge (see @grasp-os/shared/uploads). An upload
// is checked by what arrived (its size, and that its first bytes are the
// type its name says), recorded as `pending` with its audit event, its
// original stored in R2 under its hash, and its extraction started: a run
// of core's own workflow (extraction.ts) on the engine, whose one step
// extracts the text and saves it as the next version of the document at
// the file's name, in the save pipeline's batch, which marks the upload
// ready too. Whatever fails ends the upload failed, with the code of why.
//
// Originals are kept while an upload needs them: for downloading the
// original of a document's version, which comes as an attachment only
// (threat model R20). The original of a failed upload is deleted,
// outbox-style: the delete is recorded in the batch that fails the upload
// (`upload_cleanups`), done, then cleared; the cron trigger finishes one a
// failure interrupted. Uploads of the same file to the same collection
// share one original, which is deleted only once no upload but failed ones
// names it. An identical file uploaded in the moment between that check
// and the delete finds its original gone, and fails with a reason that says
// to upload it again.

/** The key of an original in R2: its collection and its hash. */
export const originalKey = (collectionId: string, sha256: string): string =>
  `knowledge/${collectionId}/${sha256}`;

/** An upload's extraction run: its instance on the engine. */
export const extractionRunId = (uploadId: string): string =>
  `upload-${uploadId}`;

type UploadRow = typeof uploads.$inferSelect;

/** The first bytes of each type: a PDF's header, a ZIP's for Office files. */
const signatures: Readonly<Record<UploadExtension, readonly number[]>> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
  docx: [0x50, 0x4b, 0x03, 0x04],
  xlsx: [0x50, 0x4b, 0x03, 0x04],
};

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");

/** An upload's type, one core stored from the types allowed. */
const mediaTypeOf = (row: UploadRow): UploadMediaType =>
  uploadMediaTypeSchema.parse(row.mediaType);

/** The message people see for a stored failure code. */
const failureMessage = (code: string): string => {
  const coded = { code };
  const upload = uploadErrors.codeOf(coded);
  if (upload !== undefined) {
    return uploadErrors.create(upload).message;
  }
  const knowledge = knowledgeErrors.codeOf(coded);
  if (knowledge !== undefined) {
    return knowledgeErrors.create(knowledge).message;
  }
  const feature = featureErrors.codeOf(coded);
  if (feature !== undefined) {
    return featureErrors.create(feature).message;
  }
  return internalErrors.create("internal.unexpected").message;
};

const toUpload = (row: UploadRow): Upload => ({
  id: row.id,
  collectionId: collectionIdSchema.parse(row.collectionId),
  name: row.path,
  mediaType: mediaTypeOf(row),
  bytes: row.bytes,
  status: row.status,
  documentId:
    row.documentId === null ? null : documentIdSchema.parse(row.documentId),
  version: row.version,
  failure:
    row.failure === null
      ? null
      : { code: row.failure, message: failureMessage(row.failure) },
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Refuses while uploads, or Knowledge itself, are switched off. */
const requireUploads = (env: Env): void => {
  requireFeature(env, "knowledge");
  requireFeature(env, "knowledge_uploads");
};

/** Whether uploads, and Knowledge itself, are switched on. */
const uploadsOn = (env: Env): boolean =>
  featureEnabled(env, "knowledge") && featureEnabled(env, "knowledge_uploads");

/**
 * Deletes the original from R2 unless an upload that isn't failed still
 * names it, then clears the cleanup recorded for it.
 */
const cleanUp = async (
  env: Env,
  db: DrizzleD1Database,
  { collectionId, sha256 }: { collectionId: string; sha256: string }
): Promise<void> => {
  const needed = await db
    .select({ id: uploads.id })
    .from(uploads)
    .where(
      and(
        eq(uploads.collectionId, collectionId),
        eq(uploads.sha256, sha256),
        ne(uploads.status, "failed")
      )
    )
    .limit(1)
    .get();
  if (needed === undefined) {
    await env.FILES.delete(originalKey(collectionId, sha256));
  }
  await db
    .delete(uploadCleanups)
    .where(
      and(
        eq(uploadCleanups.collectionId, collectionId),
        eq(uploadCleanups.sha256, sha256)
      )
    );
};

/**
 * Fails the upload with `code`, unless it is ready or failed already: in
 * one batch with its audit event and the cleanup of its original, which
 * then runs.
 */
export const failUpload = async (
  env: Env,
  uploadId: string,
  code: string
): Promise<void> => {
  const db = drizzle(env.KNOWLEDGE);
  const row = await db
    .select()
    .from(uploads)
    .where(eq(uploads.id, uploadId))
    .get();
  if (row === undefined || row.status === "ready" || row.status === "failed") {
    return;
  }
  const now = new Date();
  await auditedBatch(env, db, [
    db
      .update(uploads)
      .set({ status: "failed", failure: code, updatedAt: now })
      .where(
        and(
          eq(uploads.id, uploadId),
          inArray(uploads.status, ["pending", "extracting"])
        )
      ),
    outboxedIfChanged(db, {
      actor: { type: "system" },
      action: "knowledge.upload.failed",
      target: { type: "upload", id: uploadId },
      detail: { collectionId: row.collectionId, reason: code },
    }),
    db
      .insert(uploadCleanups)
      .values({
        collectionId: row.collectionId,
        sha256: row.sha256,
        createdAt: now,
      })
      .onConflictDoNothing(),
  ]);
  await cleanUp(env, db, row);
};

/**
 * Uploads a file into a collection `person` may change, and starts
 * extracting its text. Returns the upload, `pending`.
 */
export const uploadFile = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<Upload> => {
  const { collectionId, name, bytes } = uploadErrors.parse(
    "upload.invalid",
    uploadInputSchema,
    input
  );
  // By the bytes that arrived, never by a size anyone reported.
  if (bytes.byteLength > uploadMaxBytes) {
    throw uploadErrors.create("upload.too_large", {
      bytes: bytes.byteLength,
      maxBytes: uploadMaxBytes,
    });
  }
  const extension = uploadExtensionOf(name);
  if (
    extension === undefined ||
    !signatures[extension].every((byte, index) => bytes[index] === byte)
  ) {
    throw uploadErrors.create("upload.unsupported");
  }
  const db = drizzle(env.KNOWLEDGE);
  const collection = await readableCollection(
    db,
    await allowedCollections(env, db, { type: "person", person }),
    collectionId
  );
  requireWritable(env, person, collection);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const now = new Date();
  const actor = actorOf(person);
  const row: UploadRow = {
    id: crypto.randomUUID(),
    collectionId: collection.id,
    path: name,
    mediaType: uploadTypes[extension],
    bytes: bytes.byteLength,
    sha256,
    uploadedBy: person.userId,
    actor: JSON.stringify(actor),
    status: "pending",
    failure: null,
    documentId: null,
    version: null,
    createdAt: now,
    updatedAt: now,
  };
  await auditedBatch(env, db, [
    db.insert(uploads).values(row),
    outboxed(db, {
      actor,
      action: "knowledge.upload.received",
      target: { type: "upload", id: row.id },
      detail: {
        collectionId: collection.id,
        mediaType: row.mediaType,
        bytes: row.bytes,
      },
    }),
  ]);
  try {
    // R2 checks what it stores against the hash its key names.
    await env.FILES.put(originalKey(collection.id, sha256), bytes, {
      sha256,
    });
    await runEngine(env).createInternal({
      id: extractionRunId(row.id),
      workflow: "extraction",
      input: { uploadId: row.id },
    });
  } catch (error) {
    // Failed at once, so its uploader sees why; if even that fails, the
    // cron trigger finds it pending and starts its run (`sweepUploads`).
    try {
      await failUpload(env, row.id, "internal.unexpected");
    } catch (cleanupError) {
      log.error("upload.fail_failed", errorFields(cleanupError));
    }
    throw error;
  }
  return toUpload(row);
};

/** An upload `person` made; `upload.not_found` for anyone else's. */
export const getUpload = async (
  env: Env,
  person: Identity,
  uploadId: unknown
): Promise<Upload> => {
  const row =
    typeof uploadId === "string"
      ? await drizzle(env.KNOWLEDGE)
          .select()
          .from(uploads)
          .where(
            and(eq(uploads.id, uploadId), eq(uploads.uploadedBy, person.userId))
          )
          .get()
      : undefined;
  if (row === undefined) {
    throw uploadErrors.create("upload.not_found");
  }
  return toUpload(row);
};

/** The title of a file's document: its name without the extension. */
const fileTitle = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};

/**
 * The document for a file's Markdown: frontmatter naming the original,
 * then the text. The frontmatter is written here, so text that starts
 * with `---` stays text.
 */
const documentText = (row: UploadRow, markdown: string): string =>
  `---\n${stringify({
    type: "file",
    title: fileTitle(row.path),
    original: row.path,
    mediaType: row.mediaType,
  })}---\n\n${markdown}\n`;

const headingLine = /^#{1,6}\s/u;
const tableSyntax = /[\s|-]/gu;

/** Whether Markdown holds any text beyond headings and table rules. */
const hasText = (markdown: string): boolean =>
  markdown
    .split("\n")
    .filter((line) => !headingLine.test(line))
    .join("")
    .replaceAll(tableSyntax, "") !== "";

/**
 * Whether an upload of the same name to the same collection, made after
 * `row`, is saved already: its version is the later one. Uploads made in
 * the same millisecond are ordered by ID, so any two are ordered.
 */
const laterUploadSaved = async (
  db: DrizzleD1Database,
  row: UploadRow
): Promise<boolean> =>
  (await db
    .select({ id: uploads.id })
    .from(uploads)
    .where(
      and(
        eq(uploads.collectionId, row.collectionId),
        eq(uploads.path, row.path),
        eq(uploads.status, "ready"),
        or(
          gt(uploads.createdAt, row.createdAt),
          and(eq(uploads.createdAt, row.createdAt), gt(uploads.id, row.id))
        )
      )
    )
    .limit(1)
    .get()) !== undefined;

/** Errors extracting may end with that no retry changes. */
export const finalFailures: ReadonlySet<string> = new Set([
  "upload.unreadable",
  "upload.no_text",
  "upload.original_missing",
  "upload.superseded",
  "knowledge.too_large",
  "knowledge.too_many_sections",
  "knowledge.too_many_links",
  "knowledge.invalid",
  "knowledge.read_only",
  "knowledge.forbidden",
]);

/**
 * The extraction run's one step: extracts the upload's text with
 * `extractor` and saves it as the next version of its document, marking
 * the upload ready in the same batch. Safe to run again: an upload that is
 * ready or failed, or gone with its collection, is left as it is. Throws
 * an expected error for what the run fails the upload with, and anything
 * else for what a retry may fix.
 */
export const extractUpload = async (
  env: Env,
  uploadId: string,
  extractor: Extractor
): Promise<void> => {
  const db = drizzle(env.KNOWLEDGE);
  const found = await db
    .select({ upload: uploads, collection: collections })
    .from(uploads)
    .innerJoin(collections, eq(collections.id, uploads.collectionId))
    .where(eq(uploads.id, uploadId))
    .get();
  if (
    found === undefined ||
    ["ready", "failed"].includes(found.upload.status)
  ) {
    return;
  }
  requireUploads(env);
  const { upload: row, collection } = found;
  await db
    .update(uploads)
    .set({ status: "extracting", updatedAt: new Date() })
    .where(and(eq(uploads.id, uploadId), eq(uploads.status, "pending")));
  const original = await env.FILES.get(
    originalKey(row.collectionId, row.sha256)
  );
  if (original === null) {
    throw uploadErrors.create("upload.original_missing");
  }
  let markdown: string;
  try {
    markdown = await extractor({
      name: row.path,
      mediaType: mediaTypeOf(row),
      bytes: new Uint8Array(await original.arrayBuffer()),
    });
  } catch (error) {
    // The error's name only: a parser's message may quote the file.
    log.warn("upload.unreadable", {
      uploadId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw uploadErrors.create("upload.unreadable");
  }
  if (!hasText(markdown)) {
    throw uploadErrors.create("upload.no_text");
  }
  // The version first, then a later upload: one saved after this read
  // moves the version on, and the save below conflicts.
  const current = await findByPath(db, row.collectionId, row.path);
  const ifVersion = current?.currentVersion ?? 0;
  if (await laterUploadSaved(db, row)) {
    throw uploadErrors.create("upload.superseded");
  }
  const actor: AuditActor = auditActorSchema.parse(JSON.parse(row.actor));
  // A conflict (someone saved the document meanwhile) throws, and the
  // step's retry saves on top of their version.
  await writeVersion(
    env,
    { actor, userId: row.uploadedBy },
    {
      collection,
      path: row.path,
      text: documentText(row, markdown),
      ifVersion,
      message: `Uploaded ${row.path}`,
      restoredFrom: null,
      also: [
        db
          .update(uploads)
          .set({
            status: "ready",
            documentId: sql`(SELECT id FROM documents WHERE collection_id = ${row.collectionId} AND path = ${row.path})`,
            version: ifVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(uploads.id, uploadId)),
      ],
    }
  );
};

/** Most uploads, and cleanups, looked at at once. */
const sweepBatch = 20;

/**
 * Statements for a purge's batch (purge.ts) that forget the uploads
 * `where` selects and record their originals for deleting, which
 * `cleanUpOriginals` then does.
 */
export const forgetUploads = (db: DrizzleD1Database, where: SQL) =>
  [
    db
      .insert(uploadCleanups)
      .select(
        db
          .selectDistinct({
            collectionId: uploads.collectionId,
            sha256: uploads.sha256,
            createdAt: sql<Date>`${Date.now()}`.as("created_at"),
          })
          .from(uploads)
          .where(where)
      )
      .onConflictDoNothing(),
    db.delete(uploads).where(where),
  ] as const;

/**
 * Deletes the originals recorded for deleting, a few at a time, and clears
 * each once done. Never throws: whoever recorded them has committed
 * already, and the cron trigger deletes what's left.
 */
export const cleanUpOriginals = async (env: Env): Promise<void> => {
  const db = drizzle(env.KNOWLEDGE);
  try {
    const cleanups = await db
      .select()
      .from(uploadCleanups)
      .orderBy(asc(uploadCleanups.createdAt))
      .limit(sweepBatch);
    for (const cleanup of cleanups) {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      await cleanUp(env, db, cleanup);
    }
  } catch (error) {
    log.error("upload.cleanup_failed", errorFields(error));
  }
};

/** How long an upload may go unchanged before the cron trigger looks at it. */
const staleAfterMs = 10 * 60_000;

/** Where the engine has a run that has ended. */
const endedStatuses: ReadonlySet<string> = new Set([
  "complete",
  "errored",
  "terminated",
]);

/**
 * Every minute (index.ts): deletes the originals whose cleanup a failure
 * interrupted, and looks at uploads unchanged for a while that haven't
 * ended: one whose run never started (core stopped between recording it
 * and starting it) gets its run, and one whose run ended without ending it
 * fails.
 */
export const sweepUploads = async (env: Env): Promise<void> => {
  await cleanUpOriginals(env);
  if (!uploadsOn(env)) {
    return;
  }
  const stale = await drizzle(env.KNOWLEDGE)
    .select({ id: uploads.id })
    .from(uploads)
    .where(
      and(
        inArray(uploads.status, ["pending", "extracting"]),
        lt(uploads.updatedAt, new Date(Date.now() - staleAfterMs))
      )
    )
    // In no order: uploads whose runs are still going (retrying, say)
    // stay stale for a while, and mustn't keep the rest from being seen.
    .orderBy(sql`random()`)
    .limit(sweepBatch);
  const engine = runEngine(env);
  for (const { id } of stale) {
    // oxlint-disable-next-line no-await-in-loop -- a few at a time
    const run = await engine.status(extractionRunId(id));
    if (run === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      await engine.createInternal({
        id: extractionRunId(id),
        workflow: "extraction",
        input: { uploadId: id },
      });
    } else if (endedStatuses.has(run.status)) {
      // oxlint-disable-next-line no-await-in-loop -- a few at a time
      await failUpload(env, id, "internal.unexpected");
    }
  }
};

const noStore = "private, no-store";

/** A filename for `Content-Disposition`: ASCII, with the name in full after. */
const contentDisposition = (name: string): string => {
  const fallback = name.replaceAll(/[^\u0020-\u007E]|["\\]/gu, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

/**
 * `GET /api/knowledge/uploads/<id>/original`: the original of an upload
 * saved as a document the signed-in person may read, recorded as a read
 * of that document. Only ever as a download (threat model R20): an
 * attachment, with the type its extension allowed (never one a browser
 * runs) and `nosniff` (security-headers.ts), so no uploaded file runs on
 * the product's origin.
 */
export const originalResponse = async (
  request: Request,
  env: Env,
  uploadId: string,
  requestId: string
): Promise<Response> => {
  const notFound = () =>
    errorResponse(404, requestErrors.create("request.not_found"), requestId);
  if (request.method !== "GET" || !uploadsOn(env)) {
    return notFound();
  }
  const person = await identify(env, request.headers);
  if (person === undefined) {
    return errorResponse(
      401,
      authErrors.create("auth.unauthenticated"),
      requestId
    );
  }
  const db = drizzle(env.KNOWLEDGE);
  const reader = { type: "person", person } as const;
  const found = await db
    .select({ upload: uploads, collection: collections })
    .from(uploads)
    .innerJoin(collections, eq(collections.id, uploads.collectionId))
    .where(
      and(
        eq(uploads.id, uploadId),
        eq(uploads.status, "ready"),
        await allowedCollections(env, db, reader)
      )
    )
    .get();
  const original = found
    ? await env.FILES.get(originalKey(found.collection.id, found.upload.sha256))
    : null;
  const documentId = found?.upload.documentId ?? null;
  if (!(found && original) || documentId === null) {
    return notFound();
  }
  const { upload } = found;
  await noteProvenance(
    env,
    reader,
    {
      action: "knowledge.read",
      target: { type: "document", id: documentId },
      detail: { read: "original", upload: upload.id, version: upload.version },
    },
    found.collection
  );
  return new Response(original.body, {
    headers: {
      "content-type": mediaTypeOf(upload),
      "content-disposition": contentDisposition(upload.path),
      "content-length": String(original.size),
      "cache-control": noStore,
    },
  });
};
