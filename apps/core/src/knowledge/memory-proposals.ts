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
import { and, asc, count, eq, ne, sql } from "drizzle-orm";
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

/** Most proposals one agent may have waiting at once. */
export const proposalsMaxPendingPerAgent = 20;

const sourceSchema = z.object({
  actor: auditActorSchema,
  context: workContextSchema,
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
 * included), and nothing changes until it is approved.
 *
 * Throws `permission.denied` for anything but an agent,
 * `permission.person_inactive` when its person has left,
 * `permission.context_invalid` for a context it can't work in,
 * `permission.restricted` from a context that read restricted data (as
 * `saveUserMemory` does: shared memory would carry it to everyone),
 * `knowledge.not_found` while no admin has set up the Memory collection,
 * and `knowledge.too_many_proposals` while the agent has
 * {@link proposalsMaxPendingPerAgent} waiting.
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
  if (await isRestricted(env, authority, work)) {
    throw permissionErrors.create("permission.restricted");
  }
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
  const source: MemoryProposalSource = { actor, context: work };
  const row: ProposalRow = {
    id: crypto.randomUUID(),
    collectionId: collection.id,
    path,
    baseVersion: existing?.currentVersion ?? 0,
    text,
    message: message === undefined || message === "" ? null : message,
    source: JSON.stringify(source),
    agentId: subject.agentId,
    status: "pending",
    decidedBy: null,
    createdAt: new Date(),
    decidedAt: null,
  };
  const pending = db
    .select({ count: count() })
    .from(memoryProposals)
    .where(
      and(
        eq(memoryProposals.agentId, row.agentId),
        eq(memoryProposals.status, "pending")
      )
    );
  const [inserted] = await auditedBatch(env, db, [
    // Inserted only while the agent has fewer than the most waiting,
    // counted in the same statement, so proposals made at once can't
    // together pass it. The columns in the table's order.
    db
      .insert(memoryProposals)
      .select(
        sql`SELECT ${row.id}, ${row.collectionId}, ${row.path}, ${row.baseVersion}, ${row.text}, ${row.message}, ${row.source}, ${row.agentId}, ${row.status}, NULL, ${row.createdAt.getTime()}, NULL WHERE (${pending}) < ${proposalsMaxPendingPerAgent}`
      )
      .returning({ id: memoryProposals.id }),
    outboxedIfChanged(db, {
      actor,
      action: "knowledge.proposal.created",
      target: { type: "proposal", id: row.id },
      provenance: existing ? [existing.id] : [],
      detail: {
        collectionId: collection.id,
        baseVersion: row.baseVersion,
      },
    }),
  ]);
  if (inserted.length === 0) {
    throw knowledgeErrors.create("knowledge.too_many_proposals", {
      maxPending: proposalsMaxPendingPerAgent,
    });
  }
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
 * Fails the batch it is in unless `proposal` is approved by now: it
 * inserts the proposal's own row again, under the same ID, whenever its
 * status is anything else, and the primary key refuses that, which rolls
 * the whole batch back. So an approval whose `decide` changed nothing (a
 * decline got there first) saves nothing either. When the proposal is
 * approved it selects no row and inserts nothing.
 */
const unlessApproved = (
  db: ReturnType<typeof drizzle>,
  proposal: ProposalRow
) =>
  db.insert(memoryProposals).select(
    db
      .select()
      .from(memoryProposals)
      .where(
        and(
          eq(memoryProposals.id, proposal.id),
          ne(memoryProposals.status, "approved")
        )
      )
  );

/**
 * Approves a pending proposal: its text becomes the file's next version,
 * by `person`, in the same batch that marks it approved, which commits
 * only if this approval is what decided it (`unlessApproved`). If the file
 * changed since it was proposed, `knowledge.conflict`, and it stays
 * pending, to be declined or proposed again; if it was decided meanwhile,
 * `knowledge.proposal_decided`, and nothing is saved.
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
  try {
    return await writeVersion(env, personWriter(person), {
      collection,
      path: proposal.path,
      text: proposal.text,
      ifVersion: proposal.baseVersion,
      message: proposal.message,
      restoredFrom: null,
      also: [
        decide(db, person, proposal, "approved"),
        unlessApproved(db, proposal),
        outboxed(
          db,
          decisionEntry(person, proposal, "knowledge.proposal.approved")
        ),
      ],
    });
  } catch (error) {
    // A batch refused by a primary key reaches us as a conflict: the
    // guard's, when the proposal was decided meanwhile.
    if (knowledgeErrors.codeOf(error) === "knowledge.conflict") {
      const now = await db
        .select({ status: memoryProposals.status })
        .from(memoryProposals)
        .where(eq(memoryProposals.id, proposal.id))
        .get();
      if (now?.status !== "pending") {
        throw knowledgeErrors.create("knowledge.proposal_decided");
      }
    }
    throw error;
  }
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
