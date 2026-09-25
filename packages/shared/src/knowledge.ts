import { z } from "zod";

import { auditIdentifierMaxLength } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";
import { collectionIdSchema, documentIdSchema } from "./ids.ts";
import type { CollectionId, DocumentId } from "./ids.ts";

// Knowledge: Markdown documents with typed frontmatter, in collections. A
// save never overwrites: it adds a version, and names the version it was
// edited from, so two people editing at once get a conflict instead of
// losing a change.

const identifier = () => z.string().min(1).max(auditIdentifierMaxLength);

/**
 * Who may read a collection: everyone in the organization, the members of
 * its teams, or only its owner.
 */
export const collectionAccessSchema = z.enum(["everyone", "teams", "me"]);
export type CollectionAccess = z.infer<typeof collectionAccessSchema>;

/**
 * Where a collection's documents come from: written here, uploaded, the
 * Playbook, shipped by Grasp, or derived from Apps. The last two are
 * read-only for people and agents: only the platform writes them.
 */
export const collectionSourceSchema = z.enum([
  "here",
  "upload",
  "playbook",
  "grasp",
  "apps",
]);
export type CollectionSource = z.infer<typeof collectionSourceSchema>;

/** Sources only the platform writes. */
export const readOnlySources: ReadonlySet<CollectionSource> = new Set([
  "grasp",
  "apps",
]);

/** Most teams one collection is shared with. */
export const collectionMaxTeams = 50;

/** A new collection, as a person creates it. */
export const collectionInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    /** When to use it: what agents see before they look inside. */
    description: z.string().trim().max(1024).default(""),
    access: collectionAccessSchema,
    /** The teams that may read it; only for `teams` access. */
    teams: z
      .array(identifier())
      .max(collectionMaxTeams)
      .default([])
      .transform((teams) => [...new Set(teams)]),
    /** Marks a team collection's content as sensitive for the model gateway. */
    sensitive: z.boolean().default(false),
  })
  .superRefine(({ access, teams, sensitive }, context) => {
    if (access === "teams" && teams.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["teams"],
        message: "A team collection needs at least one team",
      });
    }
    if (access !== "teams" && teams.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["teams"],
        message: "Only a team collection has teams",
      });
    }
    if (sensitive && access !== "teams") {
      context.addIssue({
        code: "custom",
        path: ["sensitive"],
        message: "Only a team collection can be marked sensitive",
      });
    }
  });
export type CollectionInput = z.input<typeof collectionInputSchema>;

/** A collection, as the API returns it. */
export interface Collection {
  id: CollectionId;
  name: string;
  description: string;
  /** The user ID of the person who owns it. */
  owner: string;
  access: CollectionAccess;
  /** Team IDs, for `teams` access. */
  teams: string[];
  sensitive: boolean;
  source: CollectionSource;
  /** ISO 8601. */
  createdAt: string;
}

/** Longest document path, in characters. */
export const documentPathMaxLength = 512;

// oxlint-disable-next-line no-control-regex -- control characters are what it finds
const controlCharacters = /[\u0000-\u001F\u007F]/u;

/**
 * Why `path` isn't a document path, or `undefined` when it is one. A path is
 * relative, with `/` between folders, and names one document in its
 * collection, such as `handbook/leave.md`.
 */
export const documentPathProblem = (path: string): string | undefined => {
  if (path.length === 0 || path.length > documentPathMaxLength) {
    return `A path has 1 to ${documentPathMaxLength} characters`;
  }
  if (controlCharacters.test(path) || path.includes("\\")) {
    return "A path has no control characters or backslashes";
  }
  if (
    path
      .split("/")
      .some(
        (segment) =>
          segment.trim() === "" || segment === "." || segment === ".."
      )
  ) {
    return "A path has no empty, blank, '.' or '..' folders and doesn't start or end with /";
  }
  return undefined;
};

export const documentPathSchema = z.string().superRefine((path, context) => {
  const problem = documentPathProblem(path);
  if (problem !== undefined) {
    context.addIssue({ code: "custom", message: problem });
  }
});

/** A version number: 1 for a document's first version. */
const versionSchema = z.int().min(1);

/**
 * A save: the whole Markdown text of the document at `path`, and the
 * version it was edited from (`ifVersion`, 0 for a new document). If the
 * document has moved past that version, nothing is saved.
 */
export const saveInputSchema = z.strictObject({
  collectionId: identifier().pipe(collectionIdSchema),
  path: documentPathSchema,
  text: z.string(),
  ifVersion: z.int().min(0),
  /** What changed, for the history. */
  message: z.string().trim().max(500).optional(),
});
export type SaveInput = z.input<typeof saveInputSchema>;

/** A restore: an earlier version's text becomes the next version. */
export const restoreInputSchema = z.strictObject({
  documentId: identifier().pipe(documentIdSchema),
  version: versionSchema,
  ifVersion: versionSchema,
});
export type RestoreInput = z.input<typeof restoreInputSchema>;

export const documentIdInputSchema = identifier().pipe(documentIdSchema);
export const collectionIdInputSchema = identifier().pipe(collectionIdSchema);
export const versionInputSchema = versionSchema;

/** Most entries one page of a listing holds. */
export const pageMaxLimit = 200;

/** A page of documents: in path order, after `after`. */
export const listDocumentsOptionsSchema = z
  .strictObject({
    after: documentPathSchema.optional(),
    limit: z.int().min(1).max(pageMaxLimit).default(pageMaxLimit),
  })
  .default({ limit: pageMaxLimit });
export type ListDocumentsOptions = z.input<typeof listDocumentsOptionsSchema>;

/** A page of history: newest first, before version `before`. */
export const historyOptionsSchema = z
  .strictObject({
    before: versionSchema.optional(),
    limit: z.int().min(1).max(pageMaxLimit).default(pageMaxLimit),
  })
  .default({ limit: pageMaxLimit });
export type HistoryOptions = z.input<typeof historyOptionsSchema>;

/** The kinds of document, each with its own frontmatter. */
export const documentTypeSchema = z.enum([
  "doc",
  "skill",
  "memory",
  "decision",
  "file",
]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/** A document's current state, without its text. */
export interface DocumentSummary {
  id: DocumentId;
  collectionId: CollectionId;
  path: string;
  title: string;
  type: DocumentType;
  /** When to use it: what agents see before they read it. */
  description: string;
  /** Its owner, from its frontmatter, or the person who created it. */
  owner: string;
  tags: string[];
  /** When it should be reviewed (`YYYY-MM-DD`), if set. */
  reviewDate: string | null;
  currentVersion: number;
  /** ISO 8601. */
  updatedAt: string;
}

/** One version in a document's history, without its text. */
export interface VersionSummary {
  number: number;
  /** The user ID of the person who saved it. */
  author: string;
  message: string | null;
  /** The version it restored, if it was a restore. */
  restoredFrom: number | null;
  /** ISO 8601. */
  createdAt: string;
}

/** A version with its whole text, frontmatter included. */
export interface Version extends VersionSummary {
  text: string;
}

/** A document with one of its versions. */
export interface DocumentRead extends DocumentSummary {
  version: Version;
}

/** A document that links to another one. */
export interface Backlink {
  documentId: DocumentId;
  collectionId: CollectionId;
  path: string;
  title: string;
  /** The link's own text (`[[path|label]]`), if it has one. */
  label: string | null;
}

/**
 * What a signed-in person reaches in Knowledge. Every call checks the
 * session and what the person may see and change, on the server.
 */
export interface KnowledgeApi {
  /** The collections the person may read. */
  listCollections: () => Promise<Collection[]>;
  /**
   * Creates a collection the person owns. Anyone can create one only they
   * can read; shared ones (everyone, teams) only admins.
   */
  createCollection: (input: CollectionInput) => Promise<Collection>;
  listDocuments: (
    collectionId: string,
    options?: ListDocumentsOptions
  ) => Promise<DocumentSummary[]>;
  /** The current version, or `version`. */
  getDocument: (documentId: string, version?: number) => Promise<DocumentRead>;
  /** Saves a new version; `knowledge.conflict` if `ifVersion` is stale. */
  saveDocument: (input: SaveInput) => Promise<DocumentSummary>;
  history: (
    documentId: string,
    options?: HistoryOptions
  ) => Promise<VersionSummary[]>;
  /** Saves an earlier version's text as a new version. */
  restoreVersion: (input: RestoreInput) => Promise<DocumentSummary>;
  /** The documents that link to this one. */
  backlinks: (documentId: string) => Promise<Backlink[]>;
}

/** Why a Knowledge call was refused. */
export const knowledgeErrors = defineErrorFamily({
  "knowledge.not_found":
    "There's no such collection, document or version, or you can't see it.",
  "knowledge.forbidden": "You can't change this collection.",
  "knowledge.read_only":
    "This collection is managed by Grasp or an App and can't be changed here.",
  "knowledge.invalid": "That isn't a valid collection or document.",
  "knowledge.too_large": "This document is too large to save.",
  "knowledge.too_many_sections":
    "This document has too many headings to save. Split it into several documents.",
  "knowledge.too_many_links":
    "This document has too many links to save. Split it into several documents.",
  "knowledge.conflict":
    "This document changed since you opened it. Load the latest version and apply your change to it.",
});
