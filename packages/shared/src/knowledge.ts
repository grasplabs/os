import { z } from "zod";

import { auditProvenanceMaxItems } from "./audit.ts";
import { defineErrorFamily } from "./errors.ts";
import {
  collectionIdSchema,
  documentIdSchema,
  identifierSchema,
} from "./ids.ts";
import type { CollectionId, DocumentId } from "./ids.ts";

// Knowledge: Markdown documents with typed frontmatter, in collections. A
// save never overwrites: it adds a version, and names the version it was
// edited from, so two people editing at once get a conflict instead of
// losing a change. Only a purge rewrites versions: an admin erasing
// personal data from all of them.

/**
 * Who may read a collection: everyone in the organization, the members of
 * its teams, or only its owner.
 */
export const collectionAccessSchema = z.enum(["everyone", "teams", "me"]);
export type CollectionAccess = z.infer<typeof collectionAccessSchema>;

/**
 * Where a collection's documents come from: written here, uploaded, the
 * Playbook, shipped by Grasp, or derived from Apps. The last two are
 * read-only for people and agents: only the platform writes them. The
 * Apps collection holds each App's AGENTS.md, and each of its documents
 * is found only by those who may open that App: a listing, read or search
 * never shows the others.
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
      .array(identifierSchema)
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

/** Characters `[[path#heading|label]]` links use, so no path has them. */
const linkSyntax = /[[\]#|]/u;

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
  if (linkSyntax.test(path)) {
    return "A path has no [, ], # or |";
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

/**
 * A `[[link]]` in Markdown: `inner` is its target, then its label after
 * any `|`. Global, for `matchAll`.
 */
export const wikiLinkPattern = /\[\[(?<inner>[^[\]\n]+)\]\]/gu;

const extension = /\.[^./]+$/u;

/**
 * The path a `[[link]]` names, from its target (the part before any `|`):
 * relative to the collection, with `.md` added when it names no
 * extension. `undefined` when it isn't a document path. Core indexes
 * links by it, and the web app resolves them by it.
 */
export const linkPath = (target: string): string | undefined => {
  const [withoutHeading = ""] = target.split("#");
  const trimmed = withoutHeading.trim();
  if (trimmed === "") {
    // A link to a heading in the same document.
    return undefined;
  }
  const path = extension.test(trimmed) ? trimmed : `${trimmed}.md`;
  return documentPathProblem(path) === undefined ? path : undefined;
};

export const documentPathSchema = z.string().superRefine((path, context) => {
  const problem = documentPathProblem(path);
  if (problem !== undefined) {
    context.addIssue({ code: "custom", message: problem });
  }
});

const frontmatterFence = /^---[ \t]*$/u;
const lineBreak = /\r?\n/u;
const byteOrderMark = "\uFEFF";

/**
 * A document's frontmatter, the YAML between `---` lines at its top (after
 * a byte order mark, if it has one), and the Markdown after it: `yaml` is
 * `undefined` when it has none, and the whole is `undefined` when it opens
 * a block it never closes, which core refuses to save. Core reads
 * frontmatter by it, and the web app leaves it out of the rendered text.
 */
export const splitFrontmatterBlock = (
  text: string
): { yaml: string | undefined; body: string } | undefined => {
  const source = text.startsWith(byteOrderMark) ? text.slice(1) : text;
  const lines = source.split(lineBreak);
  if (!frontmatterFence.test(lines[0] ?? "")) {
    return { yaml: undefined, body: source };
  }
  const end = lines.findIndex(
    (line, index) => index > 0 && frontmatterFence.test(line)
  );
  if (end === -1) {
    return undefined;
  }
  return {
    yaml: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
};

/** A version number: 1 for a document's first version. */
const versionSchema = z.int().min(1);

/**
 * A save: the whole Markdown text of the document at `path`, and the
 * version it was edited from (`ifVersion`, 0 for a new document). If the
 * document has moved past that version, nothing is saved.
 */
export const saveInputSchema = z.strictObject({
  collectionId: collectionIdSchema,
  path: documentPathSchema,
  text: z.string(),
  ifVersion: z.int().min(0),
  /** What changed, for the history. */
  message: z.string().trim().max(500).optional(),
});
export type SaveInput = z.input<typeof saveInputSchema>;

/** A restore: an earlier version's text becomes the next version. */
export const restoreInputSchema = z.strictObject({
  documentId: documentIdSchema,
  version: versionSchema,
  ifVersion: versionSchema,
});
export type RestoreInput = z.input<typeof restoreInputSchema>;

/**
 * A Grasp skill to copy into the client's skills, to adapt there: its
 * `SKILL.md`, at the same path.
 */
export const copySkillInputSchema = z.strictObject({
  documentId: documentIdSchema,
});
export type CopySkillInput = z.input<typeof copySkillInputSchema>;

/**
 * Where skills are: the Grasp skills, which ship with each release and
 * only Grasp changes, and the client's own, which its admins write. `null`
 * while one doesn't exist yet.
 */
export interface SkillCollections {
  grasp: CollectionId | null;
  client: CollectionId | null;
}

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

/**
 * The Playbook collection: one per deployment, under this ID, which no
 * other collection can have (every other one's is a random UUID). So an
 * App's blueprint can name it, and ask for it, in every deployment.
 */
export const playbookCollectionId: CollectionId =
  collectionIdSchema.parse("playbook");

/**
 * The Playbook's records: typed documents that only a Playbook collection
 * holds (the one per deployment the platform creates), with the Playbook's
 * `decision`s, which any collection can hold.
 */
export const playbookRecordTypes = [
  "vision",
  "team",
  "person",
  "tool",
  "source",
  "statement",
  "workflow",
  "snapshot",
  "plan-item",
  "rulebook-entry",
] as const;
export type PlaybookRecordType = (typeof playbookRecordTypes)[number];

/** The kinds of document, each with its own frontmatter. */
export const documentTypeSchema = z.enum([
  "doc",
  "skill",
  "memory",
  "decision",
  "file",
  ...playbookRecordTypes,
]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * A stored document's type, as this release reads it: a type it doesn't
 * know (one a later release added, still stored after a rollback) reads
 * as a plain `doc`, so adding a type never breaks reading on rollback.
 */
export const documentTypeOf = (stored: string): DocumentType =>
  documentTypeSchema.safeParse(stored).data ?? "doc";

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

/**
 * Where what a read returned comes from, so whoever builds on it (an agent,
 * an App, a sharing check) can label what it derives from it.
 */
export interface Provenance {
  /** The collections it was read from. */
  collectionIds: CollectionId[];
  /** Some of it is from a sensitive collection: the model data rules apply. */
  sensitive: boolean;
  /**
   * Some of it is restricted data: the chat, App or run that read it can no
   * longer act on or fetch from outside systems. In Knowledge, restricted
   * data is what a sensitive collection holds.
   */
  restricted: boolean;
}

/** A document with one of its versions. */
export interface DocumentRead extends DocumentSummary {
  version: Version;
  provenance: Provenance;
}

/**
 * A document read as a record: its frontmatter as data (its `type`, and
 * the fields its type's schema reads, defaults filled in), and the
 * Markdown after it. How App code, which has no YAML parser, reads a
 * Playbook record.
 */
export interface RecordRead extends DocumentRead {
  record: Record<string, unknown>;
  body: string;
}

/** A page of a collection's documents. */
export interface DocumentPage {
  documents: DocumentSummary[];
  provenance: Provenance;
}

/** A page of a document's history. */
export interface HistoryPage {
  versions: VersionSummary[];
  provenance: Provenance;
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

/** A page of the documents that link to one document. */
export interface BacklinkPage {
  backlinks: Backlink[];
  provenance: Provenance;
}

/** Longest search query, in characters. */
export const searchQueryMaxLength = 500;

/** Most results one search returns. */
export const searchMaxLimit = 50;

const searchDefaultLimit = 20;

/** A search's words, as someone typed them: no query syntax. */
export const searchQuerySchema = z.string().max(searchQueryMaxLength);

/**
 * How many results a search on one collection returns, best first, and of
 * which type of document only, if one is given.
 */
export const collectionSearchOptionsSchema = z
  .strictObject({
    type: documentTypeSchema.optional(),
    limit: z.int().min(1).max(searchMaxLimit).default(searchDefaultLimit),
  })
  .default({ limit: searchDefaultLimit });
export type CollectionSearchOptions = z.input<
  typeof collectionSearchOptionsSchema
>;

/**
 * Where to search, for which type of document, and how many results to
 * return, best first.
 */
export const searchOptionsSchema = z
  .strictObject({
    /** Only this collection; otherwise every one the reader may read. */
    collectionId: collectionIdSchema.optional(),
    /** Only documents of this type, such as `skill`; otherwise any. */
    type: documentTypeSchema.optional(),
    limit: z.int().min(1).max(searchMaxLimit).default(searchDefaultLimit),
  })
  .default({ limit: searchDefaultLimit });
export type SearchOptions = z.input<typeof searchOptionsSchema>;

/** A section that matched a search, with its document. */
export interface SearchHit {
  documentId: DocumentId;
  collectionId: CollectionId;
  path: string;
  title: string;
  type: DocumentType;
  description: string;
  /** The section's place in its document, from 0. */
  section: number;
  /** The headings above and of the section, outermost first. */
  headings: string[];
  /** Plain text from the section, around what matched. */
  snippet: string;
}

/** A search's results, best first, and where they come from. */
export interface SearchResults {
  hits: SearchHit[];
  provenance: Provenance;
}

/**
 * Which part of a document to read: one section, by its place from 0 (a
 * search hit's `section`), or the whole document when none is given.
 */
export const readOptionsSchema = z
  .strictObject({ section: z.int().min(0).optional() })
  .default({});
export type ReadOptions = z.input<typeof readOptionsSchema>;

/**
 * A document or one of its sections, at its current version. A section is
 * its Markdown from its heading to the next one; a whole document is its
 * text, frontmatter included.
 */
export interface KnowledgeRead extends DocumentSummary {
  /** The section read, or `null` for the whole document. */
  section: {
    /** Its place in its document, from 0. */
    position: number;
    /** The headings above and of the section, outermost first. */
    headings: string[];
  } | null;
  text: string;
  provenance: Provenance;
}

/** A `[[link]]` in a document, and the document it names, if there is one. */
export interface DocumentLink {
  path: string;
  /** The link's own text (`[[path|label]]`), if it has one. */
  label: string | null;
  /** `null` while no document is at `path`. */
  documentId: DocumentId | null;
  title: string | null;
}

/** A document in a skill's folder: one of the files the skill refers to. */
export interface SkillFile {
  documentId: DocumentId;
  path: string;
  title: string;
  type: DocumentType;
  description: string;
}

/** Most backlinks, and most skill files, one `FollowResult` holds. */
export const followMaxEntries = pageMaxLimit;

/**
 * Where a document leads: its links, the documents that link to it, and,
 * for a skill, the files it refers to, each list in path order.
 */
export interface FollowResult {
  /** All of them: a document has at most 500 distinct links. */
  links: DocumentLink[];
  /** The first {@link followMaxEntries}; `backlinks()` pages past them. */
  backlinks: Backlink[];
  /**
   * For a skill, the first {@link followMaxEntries} other documents in its
   * folder and below, where the Agent Skills format keeps the files a skill
   * refers to by relative path. Empty for any other type.
   */
  files: SkillFile[];
  /** Whether `backlinks` or `files` has more than it holds. */
  truncated: boolean;
  provenance: Provenance;
}

/** A collection, as the catalog lists it. */
export interface CatalogCollection {
  id: CollectionId;
  name: string;
  /** When to use it, cut to fit the catalog. */
  description: string;
  sensitive: boolean;
}

/** A skill, as the catalog lists it: read it with `read(documentId)`. */
export interface CatalogSkill {
  documentId: DocumentId;
  collectionId: CollectionId;
  name: string;
  /** When to use it, cut to fit the catalog. */
  description: string;
}

/**
 * What an agent always has in context: the collections it may read and the
 * skills in them, within a fixed size. `truncated` when some didn't fit;
 * `search` still finds those.
 */
export interface KnowledgeCatalog {
  collections: CatalogCollection[];
  skills: CatalogSkill[];
  truncated: boolean;
}

/**
 * Knowledge as an agent uses it, across every collection it may read: a
 * small catalog always in context, then search, read and follow on demand.
 * Each of those three is recorded in the audit log, and returns where what
 * it read came from; the catalog, which only names what may be read, isn't.
 */
export interface KnowledgeTools {
  /** The readable collections and their skills, sized for always-on context. */
  catalog: () => Promise<KnowledgeCatalog>;
  /** Sections that match `query`, best first, with snippets. */
  search: (query: string, options?: SearchOptions) => Promise<SearchResults>;
  /** A document, or one section of it (a search hit's `section`). */
  read: (documentId: string, options?: ReadOptions) => Promise<KnowledgeRead>;
  /** A document's links and backlinks, and for a skill, its files. */
  follow: (documentId: string) => Promise<FollowResult>;
}

/**
 * Why personal data is purged. The audit log records it and can't be
 * purged itself, so it's one of these, never free text that could name
 * the person.
 */
export const purgeReasonSchema = z.enum([
  "offboarding",
  "erasure_request",
  "other",
]);
export type PurgeReason = z.infer<typeof purgeReasonSchema>;

/**
 * Most documents one purge of content names: as many as one audit event
 * names as provenance.
 */
export const purgeMaxDocuments = auditProvenanceMaxItems;

/**
 * Most terms one purge of content removes: enough for a person's name, its
 * joined forms ("Toms", "tomVisser") and email addresses, which a purge
 * only finds when each is a term of its own.
 */
export const purgeMaxTerms = 50;

/** Longest term, in characters: a passage of a few sentences. */
export const purgeTermMaxLength = 1000;

/**
 * What each purged term becomes: a plain scalar in YAML frontmatter and
 * plain text in Markdown, so a purged document still reads as one.
 */
export const purgedMarker = "(removed)";

/**
 * Whether `term` could be found again once replaced by the marker, in any
 * case: the marker holds it, it starts with how the marker ends, or it
 * ends with how the marker starts (the marker and the text next to it
 * would make it again).
 */
const overlapsMarker = (term: string): boolean => {
  const marker = purgedMarker.toLowerCase();
  const lower = term.toLowerCase();
  if (marker.includes(lower)) {
    return true;
  }
  for (let length = 1; length <= marker.length; length += 1) {
    if (
      lower.startsWith(marker.slice(-length)) ||
      lower.endsWith(marker.slice(0, length))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * A term to purge: none that overlaps the marker, or a purge would find it
 * again next to or in its own marker, and never finish finding it.
 */
const purgeTermSchema = z
  .string()
  .trim()
  .min(2)
  .max(purgeTermMaxLength)
  .refine((term) => !overlapsMarker(term), {
    message: `A term can't be part of "${purgedMarker}", start with its end or end with its start`,
  });

/**
 * What a purge removes, for good, from every version:
 * - `personal`: the person's Personal collection, with their USER.md, all
 *   its versions, and the memory proposals their agents made;
 * - `content`: every occurrence of the `terms` (a name, an email address,
 *   a passage), in any case and as a whole word (never inside a longer
 *   word), from the documents named, which stay: each becomes
 *   {@link purgedMarker}. A form joined to more letters or digits ("Toms",
 *   "Tom2", "tomVisser" for "Tom") must be a term of its own; the plan
 *   counts where a term still starts a longer word (`inLongerWords`).
 *   In scripts written without spaces (Chinese, Japanese, Thai, Lao,
 *   Khmer, Burmese) a term is found inside running text. A document's
 *   own path stays, and so do a snapshot's frozen workflow paths; links
 *   and other fields naming a document are rewritten like any text.
 */
export const purgeInputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("personal"),
    userId: identifierSchema,
    reason: purgeReasonSchema,
  }),
  z.strictObject({
    type: z.literal("content"),
    documentIds: z
      .array(documentIdSchema)
      .min(1)
      .max(purgeMaxDocuments)
      .transform((ids) => [...new Set(ids)]),
    terms: z.array(purgeTermSchema).min(1).max(purgeMaxTerms),
    reason: purgeReasonSchema,
  }),
]);
export type PurgeInput = z.input<typeof purgeInputSchema>;

/** What a purge would remove, to confirm with `token` before it expires. */
export interface PurgePlan {
  /** Documents it deletes (`personal`) or rewrites (`content`). */
  documents: number;
  /** Versions of them it deletes or rewrites. */
  versions: number;
  /** Memory proposals it deletes or rewrites. */
  proposals: number;
  /**
   * How often a term would still start a longer word in what the purge
   * leaves of the documents named: every version, the one it saves too,
   * and every memory proposal ("Toms", "Tomin", "tomVisser" or
   * "tom.visser@acme.test.evil" for "Tom" or the address; not "automated"
   * or "custom", where it is inside or ends one), outside a snapshot's
   * frozen workflow paths. List the forms to remove as terms of their
   * own. Always 0 for `personal`.
   */
  inLongerWords: number;
  /**
   * Originals of uploaded files it deletes (and the uploads it forgets):
   * those of the collection (`personal`), or every one uploaded as a
   * document named (`content`), whether or not a term is in its text, as
   * a file can hold one where extraction never read it.
   */
  originals: number;
  /** Confirms exactly this purge, by the admin who prepared it. */
  token: string;
  /** ISO 8601. */
  expiresAt: string;
}

/** What a confirmed purge removed. */
export interface PurgeResult {
  /** Names the purge in the audit log. */
  purgeId: string;
  documents: number;
  versions: number;
  proposals: number;
}

/**
 * What a signed-in person reaches in Knowledge. Every call checks the
 * session and what the person may see and change, on the server, and
 * every read of documents is recorded in the audit log.
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
  ) => Promise<DocumentPage>;
  /** The current version, or `version`. */
  getDocument: (documentId: string, version?: number) => Promise<DocumentRead>;
  /** Saves a new version; `knowledge.conflict` if `ifVersion` is stale. */
  saveDocument: (input: SaveInput) => Promise<DocumentSummary>;
  history: (
    documentId: string,
    options?: HistoryOptions
  ) => Promise<HistoryPage>;
  /** Saves an earlier version's text as a new version. */
  restoreVersion: (input: RestoreInput) => Promise<DocumentSummary>;
  /** A page of the documents that link to this one, in path order. */
  backlinks: (
    documentId: string,
    options?: ListDocumentsOptions
  ) => Promise<BacklinkPage>;
  /**
   * Sections that match `query`, best first, from the collections the
   * person may read, or from one of them.
   */
  search: (query: string, options?: SearchOptions) => Promise<SearchResults>;
  /** The collections the person may read and their skills, as an agent's. */
  catalog: KnowledgeTools["catalog"];
  /** A document, or one section of it. */
  read: KnowledgeTools["read"];
  /** A document's links and backlinks, and for a skill, its files. */
  follow: KnowledgeTools["follow"];
  /**
   * The Grasp skills and the client's skills collections, creating the
   * client's when an admin asks and it doesn't exist yet.
   */
  skillCollections: () => Promise<SkillCollections>;
  /**
   * Copies a Grasp skill into the client's skills, as a new document at
   * the same path: admins only. `knowledge.conflict` when the client's
   * skills have that path already.
   */
  copySkill: (input: CopySkillInput) => Promise<DocumentSummary>;
  /**
   * What a purge would remove, and a token to confirm it with. Admins
   * only, whatever the collection, but for the Grasp skills, the
   * release's text, and an App's entry in the Apps collection while the
   * App holds a term (`knowledge.read_only`, saying where): the entry is
   * made from the App's name, description and current version's
   * AGENTS.md, so the App changes first (a version without it; a name or
   * description only through its builders or Grasp support, as no API
   * changes them yet), then purge. Nothing changes yet.
   */
  preparePurge: (input: PurgeInput) => Promise<PurgePlan>;
  /**
   * Runs the purge `preparePurge` returned `token` for, with the same
   * input, by the same admin, before it expires; else
   * `knowledge.purge_expired`. The audit log records who purged what and
   * why, never what was removed.
   */
  purge: (input: PurgeInput, token: string) => Promise<PurgeResult>;
}

/**
 * One collection, as an App or agent holds it through a permission to read
 * it: `await env.HANDBOOK.getDocument(id)`. It reads that collection only,
 * and only while the person the App or agent acts for may read it too.
 * Reading restricted data puts the chat, App or run it works in in
 * restricted mode, before the data is returned. Every read is recorded in
 * the audit log.
 */
export interface CollectionReader {
  /** A page of the collection's documents, in path order. */
  listDocuments: (options?: ListDocumentsOptions) => Promise<DocumentPage>;
  /** The current version, or `version`. */
  getDocument: (documentId: string, version?: number) => Promise<DocumentRead>;
  history: (
    documentId: string,
    options?: HistoryOptions
  ) => Promise<HistoryPage>;
  /** A page of the documents that link to this one, in path order. */
  backlinks: (
    documentId: string,
    options?: ListDocumentsOptions
  ) => Promise<BacklinkPage>;
  /** Sections of the collection that match `query`, best first. */
  search: (
    query: string,
    options?: CollectionSearchOptions
  ) => Promise<SearchResults>;
  /** A document, or one section of it. */
  read: KnowledgeTools["read"];
  /** A document's links and backlinks, and for a skill, its files. */
  follow: KnowledgeTools["follow"];
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
  "knowledge.memory_too_large":
    "This memory file is over its size limit. Shorten it: agents have it in their context all the time.",
  "knowledge.too_many_sections":
    "This document has too many headings to save. Split it into several documents.",
  "knowledge.too_many_links":
    "This document has too many links to save. Split it into several documents.",
  "knowledge.proposal_decided":
    "This proposal was already approved or declined.",
  "knowledge.too_many_proposals":
    "This agent has too many proposals waiting. Approve or decline some first.",
  "knowledge.conflict":
    "This document changed since you opened it. Load the latest version and apply your change to it.",
  "knowledge.purge_expired":
    "This purge wasn't confirmed in time, or isn't the one prepared. Prepare it again.",
  "knowledge.purge_index_pending":
    "The data is deleted, but the search index isn't cleaned up yet. Run the purge again to finish.",
});
