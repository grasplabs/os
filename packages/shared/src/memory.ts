import { z } from "zod";

import type { AuditActor } from "./audit.ts";
import { appIdSchema, identifierMaxLength } from "./ids.ts";
import type { AppId, CollectionId, DocumentId } from "./ids.ts";
import type { DocumentSummary, Provenance } from "./knowledge.ts";
import type { WorkContext } from "./permissions.ts";

// Memory: the Markdown files an agent always has in its context. The
// company's AGENTS.md and MEMORY.md and each agent's AGENTS.md are
// documents in the Memory collection, each person's USER.md is in their
// own Personal collection, and an App's AGENTS.md is the file of that name
// in its code. Which of them an agent gets depends on where it works
// (`MemoryContext`), each has a size limit, and they are saved, versioned
// and read like any other Knowledge document.

/** The names of memory files. */
export const memoryFileNames = ["AGENTS.md", "MEMORY.md", "USER.md"] as const;
export type MemoryFileName = (typeof memoryFileNames)[number];

/**
 * Characters per token, for sizing memory: the usual rough average of
 * English text. A file's size in tokens is its characters over this,
 * rounded up.
 */
export const memoryCharactersPerToken = 4;

/** A memory file's size in tokens, estimated from its characters. */
export const memoryTokens = (text: string): number =>
  Math.ceil(text.length / memoryCharactersPerToken);

/** Each memory file's size limit, in tokens, unless the deployment sets one. */
export const memoryDefaultLimits: Readonly<Record<MemoryFileName, number>> = {
  "AGENTS.md": 2000,
  "MEMORY.md": 2000,
  "USER.md": 2000,
};

/** The largest limit a deployment may set: past it, memory crowds out work. */
export const memoryMaxLimit = 32_000;

/**
 * The `MEMORY_LIMITS` var: a limit in tokens per file name, such as
 * `{"USER.md": 1000}`. A file it doesn't name keeps its default.
 */
export const memoryLimitsSchema = z.strictObject({
  "AGENTS.md": z.int().min(1).max(memoryMaxLimit).optional(),
  "MEMORY.md": z.int().min(1).max(memoryMaxLimit).optional(),
  "USER.md": z.int().min(1).max(memoryMaxLimit).optional(),
} satisfies Record<MemoryFileName, z.ZodType>);

/**
 * Where an agent works, as far as memory goes:
 * - `own`: a person's own chat, working on the App `appId` when given;
 * - `direct`: an agent in a direct message with the person it acts for;
 * - `channel`: an agent in a channel others share;
 * - `workflow`: an AI step of a workflow run.
 */
export const memoryContextSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("own"), appId: appIdSchema.optional() }),
  z.strictObject({ type: z.literal("direct") }),
  z.strictObject({ type: z.literal("channel") }),
  z.strictObject({ type: z.literal("workflow") }),
]);
export type MemoryContext = z.input<typeof memoryContextSchema>;

/** Whose a memory file is. */
export type MemorySource = "company" | "agent" | "app" | "user";

/** One memory file an agent got, without its text. */
export interface MemoryFile {
  source: MemorySource;
  name: MemoryFileName;
  /** The document, for every file but an App's. */
  documentId: DocumentId | null;
  /** The App, for an App's AGENTS.md. */
  appId: AppId | null;
  /** The document's version, or the App's. */
  version: number;
  /**
   * Whether it was over its limit and cut to fit: one saved before the
   * limit was lowered, or an App's, which its code holds.
   */
  cut: boolean;
}

/** The memory for one context, assembled. */
export interface Memory {
  /** The files it holds, in the order `text` has them. */
  files: MemoryFile[];
  /**
   * Every file in its own `<memory>` block, company files first, so the
   * part shared by many contexts comes first and stays the same. Empty
   * when there are none.
   */
  text: string;
  /**
   * Changes exactly when a file is added, removed, has a new version or
   * is purged, or a file's limit changes: the same key is the same `text`.
   */
  key: string;
  provenance: Provenance;
}

/** A person's memory collections, as `MemoryApi.collections` returns them. */
export interface MemoryCollections {
  /** The company's, while an admin hasn't set it up yet `null`. */
  memory: CollectionId | null;
  /** The person's own, with their USER.md. */
  personal: CollectionId;
}

/** What a signed-in person reaches of memory. */
export interface MemoryApi {
  /**
   * The Memory collection and the person's own, which it creates if it
   * doesn't exist yet: the Memory collection only for an admin. Their
   * files are read and saved through `knowledge`.
   */
  collections: () => Promise<MemoryCollections>;
  /**
   * A page of the pending proposals the person may decide on: those for
   * collections they can change (for the Memory collection, admins),
   * oldest first, after the page whose `next` is `after`.
   */
  proposals: (options?: ProposalsOptions) => Promise<ProposalPage>;
  /** Saves a pending proposal's text as the file's next version. */
  approve: (proposalId: string) => Promise<DocumentSummary>;
  /** Turns a pending proposal down; the file stays as it is. */
  decline: (proposalId: string) => Promise<void>;
  /**
   * The sensitive collections, of those the person may read, that `text`
   * names: memory that mentions one looks restricted, and the company's
   * MEMORY.md reaches every agent. For its editor to warn with.
   */
  warnings: (text: string) => Promise<MemoryWarning[]>;
}

/**
 * A change an agent proposes to a shared memory file: the company's
 * AGENTS.md or MEMORY.md, or its own AGENTS.md (`agent`). It waits for
 * someone who can change the Memory collection to approve it.
 */
export const memoryProposalInputSchema = z.strictObject({
  file: z.enum(["AGENTS.md", "MEMORY.md", "agent"]),
  /** The whole new text of the file. */
  text: z.string(),
  /** Why, for whoever decides, and the history. */
  message: z.string().trim().max(500).optional(),
});
export type MemoryProposalInput = z.input<typeof memoryProposalInputSchema>;

/** Where a proposal came from. */
export interface MemoryProposalSource {
  /** Who proposed it: an agent, acting for a person. */
  actor: AuditActor;
  /** Where it worked. */
  context: WorkContext;
}

/** A proposed change to a shared memory file, and what became of it. */
export interface MemoryProposal {
  id: string;
  collectionId: CollectionId;
  path: string;
  /** The version it was proposed from, 0 for a file that didn't exist. */
  baseVersion: number;
  text: string;
  message: string | null;
  source: MemoryProposalSource;
  status: "pending" | "approved" | "declined";
  /** The user ID of who approved or declined it. */
  decidedBy: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  decidedAt: string | null;
}

/** Most proposals one page holds. */
export const proposalsPageMaxLimit = 200;

/** A page of proposals: `limit` of them, after the cursor `after`. */
export const proposalsOptionsSchema = z
  .strictObject({
    /** The `next` of the page before. */
    after: z.string().max(identifierMaxLength).optional(),
    limit: z
      .int()
      .min(1)
      .max(proposalsPageMaxLimit)
      .default(proposalsPageMaxLimit),
  })
  .default({ limit: proposalsPageMaxLimit });
export type ProposalsOptions = z.input<typeof proposalsOptionsSchema>;

/** A page of pending proposals, and the cursor to the next one. */
export interface ProposalPage {
  proposals: MemoryProposal[];
  /** Pass as `after` for the next page; `null` on the last. */
  next: string | null;
}

/** A sensitive collection that some memory text names. */
export interface MemoryWarning {
  collectionId: CollectionId;
  name: string;
}

/** A new USER.md, as an agent saves it for the person it acts for. */
export const userMemoryInputSchema = z.strictObject({
  text: z.string(),
  /** The version it was edited from, 0 when there's none yet. */
  ifVersion: z.int().min(0),
  /** What changed, for the history. */
  message: z.string().trim().max(500).optional(),
});
export type UserMemoryInput = z.input<typeof userMemoryInputSchema>;
