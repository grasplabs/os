import {
  actorOf,
  auditActorSchema,
  delegateActorOf,
} from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import {
  documentPathProblem,
  knowledgeErrors,
  readOnlySources,
} from "@grasp-os/shared/knowledge";
import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import {
  memoryCharactersPerToken,
  memoryMaxLimit,
  memoryProposalInputSchema,
} from "@grasp-os/shared/memory";
import type {
  MemoryProposal,
  MemoryProposalSource,
  MemoryWarning,
} from "@grasp-os/shared/memory";
import {
  permissionErrors,
  workContextSchema,
} from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "../audit-outbox.ts";
import { memberRole } from "../auth/identity.ts";
import { collections, memoryProposals } from "../db/knowledge/schema.ts";
import { requireFeature } from "../features.ts";
import { isRestricted } from "../restricted.ts";
import type { WorkContext } from "../restricted.ts";
import { allowedCollections, canWrite, readableForPerson } from "./access.ts";
import { readableCollection, requireWritable } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import {
  checkedText,
  findByPath,
  personWriter,
  writeVersion,
} from "./documents.ts";
import { agentMemoryPath, memoryCollectionId } from "./memory-files.ts";

// Proposals: how shared memory files change when an agent wants them to.
// An agent's own person's USER.md it saves itself (memory.ts); the company's
// AGENTS.md and MEMORY.md and its own AGENTS.md reach every context of
// everyone, so it only proposes their new text, with where it came from,
// and someone who can change the Memory collection (admins) approves it,
// which saves it as the next version, or declines it. Each step is audited.

type ProposalRow = typeof memoryProposals.$inferSelect;

/** Most pending proposals one listing returns. */
const proposalsMaxListed = 200;

const sourceSchema = z.object({
  actor: auditActorSchema,
  context: workContextSchema,
  restricted: z.boolean(),
});

const toProposal = (row: ProposalRow): MemoryProposal => ({
  id: row.id,
  collectionId: collectionIdSchema.parse(row.collectionId),
  path: row.path,
  baseVersion: row.baseVersion,
  text: row.text,
  message: row.message,
  source: sourceSchema.parse(JSON.parse(row.source)),
  status: row.status,
  decidedBy: row.decidedBy,
  createdAt: row.createdAt.toISOString(),
  decidedAt: row.decidedAt?.toISOString() ?? null,
});

/**
 * Proposes new text for a shared memory file, as the agent `authority`
 * working in `work`: the company's AGENTS.md or MEMORY.md, or its own
 * AGENTS.md. The text is checked as a save would check it (its limit
 * included), and nothing changes until it is approved. A context that
 * read restricted data may still propose, marked so for whoever decides:
 * they read the text before it reaches anyone.
 *
 * Throws `permission.denied` for anything but an agent,
 * `permission.person_inactive` when its person has left,
 * `permission.context_invalid` for a context it can't work in, and
 * `knowledge.not_found` while no admin has set up the Memory collection.
 */
export const proposeMemory = async (
  env: Env,
  authority: Authority,
  work: WorkContext,
  input: unknown
): Promise<MemoryProposal> => {
  requireFeature(env, "knowledge");
  requireFeature(env, "memory");
  const { file, text, message } = knowledgeErrors.parse(
    "knowledge.invalid",
    memoryProposalInputSchema,
    input
  );
  const { subject, onBehalfOf } = authority;
  if (subject.type !== "agent") {
    throw permissionErrors.create("permission.denied", { action: "write" });
  }
  if (!(await memberRole(env.DB, onBehalfOf))) {
    throw permissionErrors.create("permission.person_inactive");
  }
  const restricted = await isRestricted(env, authority, work);
  const db = drizzle(env.KNOWLEDGE);
  const collection = await readableCollection(
    db,
    await readableForPerson(env, db, onBehalfOf),
    memoryCollectionId
  );
  const path = file === "agent" ? agentMemoryPath(subject.agentId) : file;
  const problem = documentPathProblem(path);
  if (problem !== undefined) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [`file: the agent's ID doesn't make a path (${problem})`],
    });
  }
  await checkedText(env, collection, path, text);
  const existing = await findByPath(db, collection.id, path);
  const actor = delegateActorOf(authority);
  const source: MemoryProposalSource = { actor, context: work, restricted };
  const row: ProposalRow = {
    id: crypto.randomUUID(),
    collectionId: collection.id,
    path,
    baseVersion: existing?.currentVersion ?? 0,
    text,
    message: message === undefined || message === "" ? null : message,
    source: JSON.stringify(source),
    status: "pending",
    decidedBy: null,
    createdAt: new Date(),
    decidedAt: null,
  };
  await auditedBatch(env, db, [
    db.insert(memoryProposals).values(row),
    outboxed(db, {
      actor,
      action: "knowledge.proposal.created",
      target: { type: "proposal", id: row.id },
      provenance: existing ? [existing.id] : [],
      detail: {
        collectionId: collection.id,
        baseVersion: row.baseVersion,
        restricted,
      },
    }),
  ]);
  return toProposal(row);
};

/** Whether `person` may decide on proposals for `collection`. */
const canDecide = (person: Identity, collection: CollectionRow): boolean =>
  !readOnlySources.has(collection.source) && canWrite(person, collection);

/** The pending proposals `person` may decide on, oldest first. */
export const listProposals = async (
  env: Env,
  person: Identity
): Promise<MemoryProposal[]> => {
  const db = drizzle(env.KNOWLEDGE);
  const rows = await db
    .select({ proposal: memoryProposals, collection: collections })
    .from(memoryProposals)
    .innerJoin(collections, eq(collections.id, memoryProposals.collectionId))
    .where(
      and(
        eq(memoryProposals.status, "pending"),
        await allowedCollections(env, db, { type: "person", person })
      )
    )
    .orderBy(asc(memoryProposals.createdAt), asc(memoryProposals.id))
    .limit(proposalsMaxListed);
  return rows
    .filter(({ collection }) => canDecide(person, collection))
    .map(({ proposal }) => toProposal(proposal));
};

/**
 * The pending proposal `proposalId`, for `person` to decide on: not found
 * unless they can read its collection, forbidden unless they can change
 * it, and `knowledge.proposal_decided` once decided.
 */
const pendingProposal = async (
  env: Env,
  person: Identity,
  proposalId: unknown
): Promise<{ proposal: ProposalRow; collection: CollectionRow }> => {
  const id = z.string().safeParse(proposalId);
  const db = drizzle(env.KNOWLEDGE);
  const found = id.success
    ? await db
        .select({ proposal: memoryProposals, collection: collections })
        .from(memoryProposals)
        .innerJoin(
          collections,
          eq(collections.id, memoryProposals.collectionId)
        )
        .where(
          and(
            eq(memoryProposals.id, id.data),
            await allowedCollections(env, db, { type: "person", person })
          )
        )
        .get()
    : undefined;
  if (!found) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  requireWritable(person, found.collection);
  if (found.proposal.status !== "pending") {
    throw knowledgeErrors.create("knowledge.proposal_decided");
  }
  return found;
};

/** The audit entry of `person` deciding on `proposal`. */
const decisionEntry = (
  person: Identity,
  proposal: ProposalRow,
  action: "knowledge.proposal.approved" | "knowledge.proposal.declined"
): AuditEntry => ({
  actor: actorOf(person),
  action,
  target: { type: "proposal", id: proposal.id },
  detail: { collectionId: proposal.collectionId },
});

/** Marks `proposal` decided, only while it is still pending. */
const decide = (
  db: ReturnType<typeof drizzle>,
  person: Identity,
  proposal: ProposalRow,
  status: "approved" | "declined"
) =>
  db
    .update(memoryProposals)
    .set({ status, decidedBy: person.userId, decidedAt: new Date() })
    .where(
      and(
        eq(memoryProposals.id, proposal.id),
        eq(memoryProposals.status, "pending")
      )
    );

/**
 * Approves a pending proposal: its text becomes the file's next version,
 * by `person`, in the same batch that marks it approved. If the file
 * changed since it was proposed, `knowledge.conflict`, and it stays
 * pending, to be declined or proposed again. Approving and declining one
 * proposal at the same moment can save the text and leave it declined;
 * the history and the audit log show both.
 */
export const approveProposal = async (
  env: Env,
  person: Identity,
  proposalId: unknown
): Promise<DocumentSummary> => {
  const { proposal, collection } = await pendingProposal(
    env,
    person,
    proposalId
  );
  const db = drizzle(env.KNOWLEDGE);
  return await writeVersion(env, personWriter(person), {
    collection,
    path: proposal.path,
    text: proposal.text,
    ifVersion: proposal.baseVersion,
    message: proposal.message,
    restoredFrom: null,
    also: [
      decide(db, person, proposal, "approved"),
      outboxedIfChanged(
        db,
        decisionEntry(person, proposal, "knowledge.proposal.approved")
      ),
    ],
  });
};

/** Declines a pending proposal; the file stays as it is. */
export const declineProposal = async (
  env: Env,
  person: Identity,
  proposalId: unknown
): Promise<void> => {
  const { proposal } = await pendingProposal(env, person, proposalId);
  const db = drizzle(env.KNOWLEDGE);
  const [changed] = await auditedBatch(env, db, [
    decide(db, person, proposal, "declined").returning({
      id: memoryProposals.id,
    }),
    outboxedIfChanged(
      db,
      decisionEntry(person, proposal, "knowledge.proposal.declined")
    ),
  ]);
  if (changed.length === 0) {
    throw knowledgeErrors.create("knowledge.proposal_decided");
  }
};

const letterOrDigit = /[\p{L}\p{N}]/u;

/** Text to check: no larger than the largest memory file there can be. */
const warningsTextSchema = z
  .string()
  .max(memoryMaxLimit * memoryCharactersPerToken);

/**
 * Whether `text` names `name` as a whole: case aside, and not inside a
 * longer word, so a collection called "HR" isn't found in "three".
 */
const names = (text: string, name: string): boolean => {
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
  ) {
    const before = haystack.slice(Math.max(0, at - 1), at);
    const after = haystack.slice(at + needle.length, at + needle.length + 1);
    if (!(letterOrDigit.test(before) || letterOrDigit.test(after))) {
      return true;
    }
  }
  return false;
};

/**
 * The sensitive collections `person` may read that `text` names, by name
 * or by ID. Only those they may read: a warning never tells anyone of a
 * collection they can't see.
 */
export const memoryWarnings = async (
  env: Env,
  person: Identity,
  text: unknown
): Promise<MemoryWarning[]> => {
  const checked = knowledgeErrors.parse(
    "knowledge.invalid",
    warningsTextSchema,
    text
  );
  const db = drizzle(env.KNOWLEDGE);
  const sensitive = await db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(
      and(
        eq(collections.sensitive, true),
        await allowedCollections(env, db, { type: "person", person })
      )
    )
    .orderBy(asc(collections.name), asc(collections.id));
  return sensitive
    .filter(({ id, name }) => names(checked, name) || checked.includes(id))
    .map(({ id, name }) => ({
      collectionId: collectionIdSchema.parse(id),
      name,
    }));
};
