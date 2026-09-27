import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import {
  copySkillInputSchema,
  documentTypeOf,
  knowledgeErrors,
} from "@grasp-os/shared/knowledge";
import type {
  DocumentSummary,
  SkillCollections,
} from "@grasp-os/shared/knowledge";
import { errorFields, log } from "@grasp-os/shared/log";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import drawAWorkflow from "../../skills/draw-a-workflow/SKILL.md";
import runABaseline from "../../skills/run-a-baseline/SKILL.md";
import writeBoardPage from "../../skills/write-board-page/SKILL.md";
import { outboxed } from "../audit-outbox.ts";
import { collections, documents, versions } from "../db/knowledge/schema.ts";
import { featureEnabled, requireFeature } from "../features.ts";
import { allowedFor } from "./app-entries.ts";
import { ensureCollection, requireWritable } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import { personWriter, readableDocument, writeVersion } from "./documents.ts";
import type { Writer } from "./documents.ts";

// Skills in two collections, both in every person's catalog, and in an
// agent's once it is granted read of each, as for any collection (agents
// start with access to nothing):
//
// - the Grasp skills: how Grasp works (a baseline, a workflow, the board
//   page), in apps/core/skills/, bundled with each release as text, and
//   synced into their collection (source `grasp`) once per release, on
//   the first request (builtins.ts), or, while the `builtins` flag is off,
//   by the cron trigger every minute. Nobody else writes them, admins
//   neither (documents.ts `checkedText`), and a purge that names one is
//   refused: they hold no personal data, and the sync would put their
//   text back;
// - the client's skills: a collection for everyone that its admins write,
//   like any other, and where a Grasp skill is copied to be adapted.
//
// Each sync reads every Grasp skill's current text in one query and
// writes only the ones that differ from the release, each as its next
// version from the version it read: two syncs at once both try the same
// version number, and the second is refused as a conflict (by the
// version's primary key, when both got past the version check) and
// writes nothing, so a change is written once. A rollback syncs the older
// text back, as a version of its own.
//
// On the cron trigger, while old and new isolates both run during a
// rollout, each writes its own release's text if it differs, so a changed
// skill flips every minute until the rollout ends. The install on the
// first request doesn't: builtins.ts says why.

/** The Grasp skills' collection, under this ID: no other has it. */
export const graspSkillsCollectionId: CollectionId =
  collectionIdSchema.parse("grasp-skills");

/** The client's skills collection, under this ID: no other has it. */
export const clientSkillsCollectionId: CollectionId =
  collectionIdSchema.parse("skills");

/** A Grasp skill as a release ships it: its path, and its text. */
export interface GraspSkill {
  path: string;
  text: string;
}

/**
 * The Grasp skills this release ships: one `SKILL.md` each, at
 * `<name>/SKILL.md`. Add a skill's folder under apps/core/skills/ here.
 * A skill removed from the release stays in the collection as it was:
 * Knowledge never deletes a document but through a purge.
 */
export const graspSkills: readonly GraspSkill[] = [
  { path: "draw-a-workflow/SKILL.md", text: drawAWorkflow },
  { path: "run-a-baseline/SKILL.md", text: runABaseline },
  { path: "write-board-page/SKILL.md", text: writeBoardPage },
];

/** Who the sync is: Grasp itself, with no person behind it. */
const graspActor: AuditActor = { type: "system" };

/** The author and owner of the Grasp skills' versions. */
const graspWriter: Writer = { actor: graspActor, userId: "grasp" };

const graspSkillsRow = (): CollectionRow => ({
  id: graspSkillsCollectionId,
  name: "Grasp skills",
  description:
    "How Grasp works: skills that ship with each release, the same for every client. Read-only; copy one into your skills to adapt it.",
  owner: "grasp",
  access: "everyone",
  sensitive: false,
  source: "grasp",
  createdAt: new Date(),
});

/** The client's skills collection, as the admin `ownerId` sets it up. */
const clientSkillsRow = (ownerId: string): CollectionRow => ({
  id: clientSkillsCollectionId,
  name: "Our skills",
  description:
    "The company's own skills: how we do things here. Admins write them, or copy a Grasp skill here to adapt it.",
  owner: ownerId,
  access: "everyone",
  sensitive: false,
  source: "here",
  createdAt: new Date(),
});

const skillsEnabled = (env: Env): boolean =>
  featureEnabled(env, "knowledge") && featureEnabled(env, "skills");

const requireSkills = (env: Env): void => {
  requireFeature(env, "knowledge");
  requireFeature(env, "skills");
};

/**
 * Writes each Grasp skill whose current text isn't the release's (`skills`,
 * this one's unless a test passes another) as its next version, creating
 * the collection first if it doesn't exist. Does nothing while `skills`
 * is off. A skill that fails, or that another sync wrote from the same
 * version first, is logged, and the others are still written; the next
 * sync compares it again. Resolves whether every skill is the release's
 * (or `skills` is off). The install on the first request calls it, and the
 * cron trigger while `builtins` is off.
 */
export const syncGraspSkills = async (
  env: Env,
  skills: readonly GraspSkill[] = graspSkills
): Promise<boolean> => {
  if (!skillsEnabled(env)) {
    return true;
  }
  const db = drizzle(env.KNOWLEDGE);
  const stored = await db
    .select({
      path: documents.path,
      currentVersion: documents.currentVersion,
      text: versions.text,
    })
    .from(documents)
    .leftJoin(
      versions,
      and(
        eq(versions.documentId, documents.id),
        eq(versions.number, documents.currentVersion)
      )
    )
    .where(eq(documents.collectionId, graspSkillsCollectionId));
  const byPath = new Map(stored.map((row) => [row.path, row]));
  const changed = skills.filter(
    (skill) => byPath.get(skill.path)?.text !== skill.text
  );
  if (changed.length === 0) {
    return true;
  }
  const collection = await ensureCollection(env, graspSkillsRow(), graspActor);
  let complete = true;
  for (const skill of changed) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few skills, one at a time
      await writeVersion(env, graspWriter, {
        collection,
        path: skill.path,
        text: skill.text,
        ifVersion: byPath.get(skill.path)?.currentVersion ?? 0,
        message: "From the release",
        restoredFrom: null,
        graspSync: true,
      });
    } catch (error) {
      complete = false;
      // Another sync wrote it from the same version first: which text it
      // wrote, the next sync compares.
      if (knowledgeErrors.codeOf(error) !== "knowledge.conflict") {
        log.error("skills.sync_failed", {
          path: skill.path,
          ...errorFields(error),
        });
      }
    }
  }
  return complete;
};

/**
 * The client's skills collection, created by `person` if they are an
 * admin and it doesn't exist yet (they own it then; every admin can
 * change it). `undefined` for anyone else while it doesn't exist.
 */
const clientSkills = async (
  env: Env,
  person: Identity
): Promise<CollectionRow | undefined> => {
  if (isAdmin(person.role)) {
    return await ensureCollection(
      env,
      clientSkillsRow(person.userId),
      actorOf(person)
    );
  }
  return await drizzle(env.KNOWLEDGE)
    .select()
    .from(collections)
    .where(eq(collections.id, clientSkillsCollectionId))
    .get();
};

/** Whether a collection exists under `id`. */
const exists = async (env: Env, id: CollectionId): Promise<boolean> => {
  const found = await drizzle(env.KNOWLEDGE)
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, id))
    .get();
  return found !== undefined;
};

/**
 * The Grasp skills and the client's skills collections, creating the
 * client's for an admin (`clientSkills`). Behind the `skills` flag.
 */
export const skillCollections = async (
  env: Env,
  person: Identity
): Promise<SkillCollections> => {
  requireSkills(env);
  const client = await clientSkills(env, person);
  return {
    grasp: (await exists(env, graspSkillsCollectionId))
      ? graspSkillsCollectionId
      : null,
    client: client ? clientSkillsCollectionId : null,
  };
};

/**
 * Copies the Grasp skill `documentId`, at its current version, into the
 * client's skills at the same path, as `person`, through the save
 * pipeline: only by those who may change the client's skills (admins),
 * and `knowledge.conflict` when that path is taken there already.
 * `knowledge.invalid` for a document that isn't a Grasp skill;
 * `knowledge.not_found` for one `person` can't read. Recorded in the
 * audit log, with the version copied.
 */
export const copySkill = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> => {
  requireSkills(env);
  const { documentId } = knowledgeErrors.parse(
    "knowledge.invalid",
    copySkillInputSchema,
    input
  );
  const db = drizzle(env.KNOWLEDGE);
  const { document, collection } = await readableDocument(
    db,
    await allowedFor(env, db, { type: "person", person }),
    documentId
  );
  if (
    collection.id !== graspSkillsCollectionId ||
    documentTypeOf(document.type) !== "skill"
  ) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: ["documentId: not a Grasp skill"],
    });
  }
  const target = await clientSkills(env, person);
  if (!target) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
  requireWritable(env, person, target);
  // Versions never change once written (the Grasp skills are never
  // purged), so this is the text of the version the document was at when
  // read, whatever the sync wrote since.
  const copied = await db
    .select({ text: versions.text })
    .from(versions)
    .where(
      and(
        eq(versions.documentId, document.id),
        eq(versions.number, document.currentVersion)
      )
    )
    .get();
  if (!copied) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return await writeVersion(env, personWriter(person), {
    collection: target,
    path: document.path,
    text: copied.text,
    ifVersion: 0,
    message: `Copied from Grasp skills, version ${document.currentVersion}`,
    restoredFrom: null,
    also: [
      outboxed(db, {
        actor: actorOf(person),
        action: "knowledge.skill.copied",
        target: { type: "document", id: document.id },
        detail: { version: document.currentVersion, collectionId: target.id },
      }),
    ],
  });
};
