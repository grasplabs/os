import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import { collectionIdSchema } from "./ids.ts";
import type { CollectionId, DocumentId } from "./ids.ts";

// Uploads: a file (PDF, Word or Excel) uploaded into a Knowledge collection
// becomes a document there, at the file's name, holding the file's text.
// Core keeps the original and extracts its text in the background; the
// person who uploaded it follows its status until it is ready or failed. The
// same name uploaded again becomes the next version of the same document.

/** The file types an upload may be, by the extension its name ends in. */
export const uploadTypes = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;
export type UploadExtension = keyof typeof uploadTypes;
export type UploadMediaType = (typeof uploadTypes)[UploadExtension];

/** One of the types an upload may be. */
export const uploadMediaTypeSchema = z.enum([
  uploadTypes.pdf,
  uploadTypes.docx,
  uploadTypes.xlsx,
]);

/** Largest file one upload takes, in bytes: 10 MB. */
export const uploadMaxBytes = 10 * 1024 * 1024;

/**
 * Longest file name, in characters: the document's title is the name
 * without its extension, and a title has at most 200.
 */
export const uploadNameMaxLength = 200;

const extensionPattern = /\.(?<extension>[A-Za-z]+)$/u;

const isExtension = (value: string): value is UploadExtension =>
  Object.hasOwn(uploadTypes, value);

/** The upload type of a file name, by its extension; `undefined` for none. */
export const uploadExtensionOf = (
  name: string
): UploadExtension | undefined => {
  const extension = extensionPattern
    .exec(name)
    ?.groups?.extension?.toLowerCase();
  return extension !== undefined && isExtension(extension)
    ? extension
    : undefined;
};

// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const notInFileName = /[\u0000-\u001F\u007F/\\[\]#|]/u;

/**
 * A file's name, which is also the path of its document: no folders, and
 * none of the characters links use.
 */
export const uploadNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(uploadNameMaxLength)
  .refine((name) => !notInFileName.test(name), {
    message: "A file name has no /, \\, [, ], #, | or control characters",
  })
  .refine((name) => name !== "." && name !== "..", {
    message: "A file name isn't . or ..",
  });

/** What a person uploads. */
export const uploadInputSchema = z.strictObject({
  collectionId: collectionIdSchema,
  /** The file's name, such as `Travel policy.docx`. */
  name: uploadNameSchema,
  /** The file itself. */
  bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
});
export type UploadInput = z.input<typeof uploadInputSchema>;

/**
 * Where an upload is: waiting for its turn, having its text extracted,
 * saved as a version of its document, or failed (with the reason).
 */
export type UploadStatus = "pending" | "extracting" | "ready" | "failed";

/** An upload, as the person who made it sees it. */
export interface Upload {
  id: string;
  collectionId: CollectionId;
  /** The file's name, and the path of its document. */
  name: string;
  mediaType: UploadMediaType;
  /** The file's size, in bytes. */
  bytes: number;
  status: UploadStatus;
  /** The document and version it was saved as, once ready. */
  documentId: DocumentId | null;
  version: number | null;
  /** Why it failed: an error's code and its message for people. */
  failure: { code: string; message: string } | null;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
}

/** What a signed-in person reaches of uploads. */
export interface UploadsApi {
  /**
   * Uploads a file into a collection the person may change, as the next
   * version of the document at its name. Returns at once, `pending`: its
   * text is extracted in the background.
   */
  upload: (input: UploadInput) => Promise<Upload>;
  /** An upload the person made, with its status. */
  get: (uploadId: string) => Promise<Upload>;
}

/**
 * Where the original of a ready upload is downloaded from, by anyone who
 * may read its document: always as an attachment.
 */
export const uploadOriginalPath = (uploadId: string): string =>
  `/api/knowledge/uploads/${uploadId}/original`;

export const uploadErrors = defineErrorFamily({
  "upload.not_found": "There's no such upload, or you can't see it.",
  "upload.invalid": "That isn't a valid upload.",
  "upload.too_large": "This file is over the upload limit of 10 MB.",
  "upload.unsupported":
    "Only PDF, Word (.docx) and Excel (.xlsx) files can be uploaded, with a name that ends in .pdf, .docx or .xlsx.",
  "upload.unreadable":
    "The file's text couldn't be read. Check that it opens, then upload it again.",
  "upload.too_complex":
    "The file takes more work to read than an upload may take: it may be damaged, or built to be. Check that it opens, or save it again as a simpler file, then upload it again.",
  "upload.no_text":
    "The file has no text to read: a scan without a text layer has none.",
  "upload.original_missing":
    "The uploaded file is gone before its text was read. Upload it again.",
  "upload.superseded":
    "A later upload of a file with the same name was saved first, so this one wasn't.",
});
