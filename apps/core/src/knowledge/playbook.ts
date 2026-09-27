import { actorOf } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  collectionIdSchema,
  documentIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import {
  documentPathSchema,
  knowledgeErrors,
  playbookRecordTypes,
} from "@grasp-os/shared/knowledge";
import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { stringify } from "yaml";
import { z } from "zod";

import { appContents } from "../apps.ts";
import { outboxed } from "../audit-outbox.ts";
import { inList } from "../db/d1.ts";
import { collections, documents, versions } from "../db/knowledge/schema.ts";
import { requireFeature } from "../features.ts";
import { ensureCollection, requireWritable } from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import { findByPath, personWriter, writeVersion } from "./documents.ts";
import {
  FrontmatterError,
  parseFrontmatter,
  withFrontmatter,
} from "./frontmatter.ts";

// The Playbook: the company's records (its vision, teams, people, tools,
// what people said, its workflows drawn and designed, snapshots, the plan,
// decisions and rules) as typed documents in one collection per
// deployment. Records are documents like any other: saved through the
// same pipeline, with versions, search, links and purges; their
// frontmatter schemas are in frontmatter.ts.
//
// These helpers are how the Playbook Apps and the agent will write them:
// a record as data and a Markdown body, and the link from a designed
// workflow to the App workflow built from it. They are behind the
// `playbook` flag; reads go through Knowledge as for any document.

/**
 * The Playbook collection: one per deployment, under this ID, which no
 * other collection can have (every other one's is a random UUID).
 */
export const playbookCollectionId: CollectionId =
  collectionIdSchema.parse("playbook");

/** The Playbook collection, as the admin `ownerId` sets it up. */
const playbookCollectionRow = (ownerId: string): CollectionRow => ({
  id: playbookCollectionId,
  name: "Playbook",
  description:
    "The company's Playbook: vision, teams, people, tools, sources and statements, workflows drawn and designed, snapshots, the plan, decisions and rules.",
  owner: ownerId,
  access: "everyone",
  sensitive: false,
  source: "playbook",
  createdAt: new Date(),
});

const requirePlaybook = (env: Env): void => {
  requireFeature(env, "knowledge");
  requireFeature(env, "playbook");
};

/**
 * The Playbook collection, created by `person` if they are an admin and it
 * doesn't exist yet (they own it then; every admin can change it).
 * `knowledge.not_found` for anyone else while it doesn't exist.
 */
export const playbookCollection = async (
  env: Env,
  person: Identity
): Promise<CollectionRow> => {
  requirePlaybook(env);
  if (isAdmin(person.role)) {
    return await ensureCollection(
      env,
      playbookCollectionRow(person.userId),
      actorOf(person)
    );
  }
  const found = await drizzle(env.KNOWLEDGE)
    .select()
    .from(collections)
    .where(eq(collections.id, playbookCollectionId))
    .get();
  if (!found) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return found;
};

/** What a Playbook record can be: one of its types, or a decision. */
const recordTypeSchema = z.enum([...playbookRecordTypes, "decision"]);

/**
 * A record to save at `path` in the Playbook, from `ifVersion` (0 for a
 * new one): its frontmatter as data, which its type's schema checks, and
 * the Markdown a person reads. A workflow's link to an App workflow isn't
 * part of it: `linkWorkflow` sets that, and a save keeps it.
 */
const recordInputSchema = z.strictObject({
  path: documentPathSchema,
  ifVersion: z.int().min(0),
  record: z
    .looseObject({ type: recordTypeSchema })
    .refine((record) => !("app" in record), {
      path: ["app"],
      message: "Link a workflow to an App workflow with linkWorkflow",
    }),
  body: z.string(),
  /** What changed, for the history. */
  message: z.string().trim().max(500).optional(),
});

/** The text of `record`: its frontmatter, then its Markdown. */
const recordText = (record: Record<string, unknown>, body: string): string =>
  `---\n${stringify(record)}---\n${body}`;

/** The text of version `number` of `documentId`, if it has one. */
const versionText = async (
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
 * The App workflow the saved record `text` at `path` links to, if any.
 * Saved text fits its type: the save pipeline checked it.
 */
const appLinkOf = (path: string, text: string): unknown => {
  const { frontmatter } = parseFrontmatter(path, text);
  return "app" in frontmatter ? frontmatter.app : undefined;
};

/**
 * Refuses with `knowledge.invalid` a snapshot, as `text` at `path` in the
 * Playbook `collection`, that freezes a version of a record that isn't
 * there. Text that doesn't fit its type is refused the same way.
 */
const requireFrozenVersions = async (
  db: DrizzleD1Database,
  collection: CollectionRow,
  path: string,
  text: string
): Promise<void> => {
  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(path, text);
  } catch (error) {
    if (error instanceof FrontmatterError) {
      throw knowledgeErrors.create("knowledge.invalid", {
        issues: error.issues,
      });
    }
    throw error;
  }
  const { frontmatter } = parsed;
  if (!("workflows" in frontmatter) || frontmatter.workflows.length === 0) {
    return;
  }
  const { workflows } = frontmatter;
  const found = await db
    .select({ path: documents.path, currentVersion: documents.currentVersion })
    .from(documents)
    .where(
      and(
        eq(documents.collectionId, collection.id),
        inList(
          documents.path,
          workflows.map((frozen) => frozen.path)
        )
      )
    );
  // A document's versions run from 1 to its current one, and none of the
  // Playbook's are ever deleted.
  const latest = new Map(
    found.map((row) => [row.path, row.currentVersion] as const)
  );
  const missing = workflows.flatMap((frozen, index) =>
    frozen.version <= (latest.get(frozen.path) ?? 0)
      ? []
      : [
          `record.workflows.${index}: the Playbook has no version ${frozen.version} of ${frozen.path}`,
        ]
  );
  if (missing.length > 0) {
    throw knowledgeErrors.create("knowledge.invalid", { issues: missing });
  }
};

/**
 * Creates or updates a Playbook record, as `person`, through the save
 * pipeline: refused as any save is (`knowledge.invalid` when the record
 * doesn't fit its type, `knowledge.conflict` when `ifVersion` isn't
 * current), and only by those who may change the Playbook (its admins).
 * A workflow keeps the App workflow the version it was edited from links
 * to, and a snapshot freezes only versions of records the Playbook has.
 */
export const saveRecord = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> => {
  requirePlaybook(env);
  const { path, ifVersion, record, body, message } = knowledgeErrors.parse(
    "knowledge.invalid",
    recordInputSchema,
    input
  );
  const collection = await playbookCollection(env, person);
  requireWritable(env, person, collection);
  const db = drizzle(env.KNOWLEDGE);
  const existing =
    ifVersion === 0 ? undefined : await findByPath(db, collection.id, path);
  // Only from the current version: from any other, the save below refuses
  // it as a conflict, and no older link is carried into it.
  const previous =
    existing?.currentVersion === ifVersion
      ? await versionText(env, existing.id, ifVersion)
      : undefined;
  const app =
    previous === undefined || record.type !== "workflow"
      ? undefined
      : appLinkOf(path, previous);
  const text = recordText(
    app === undefined ? record : { ...record, app },
    body
  );
  await requireFrozenVersions(db, collection, path, text);
  return await writeVersion(env, personWriter(person), {
    collection,
    path,
    text,
    ifVersion,
    message: message === undefined || message === "" ? null : message,
    restoredFrom: null,
  });
};

/**
 * Links the designed workflow record `documentId`, at `ifVersion`, to the
 * workflow `workflowId` of the App `appId`, by their IDs.
 */
export const linkInputSchema = z.strictObject({
  documentId: documentIdSchema,
  ifVersion: z.int().min(1),
  appId: appIdSchema,
  workflowId: workflowIdSchema,
});
export type LinkInput = z.input<typeof linkInputSchema>;

/**
 * Links a designed workflow record to the App workflow built from it, as
 * `person`, as the record's next version: only by those who may change
 * the Playbook and may use the App (`appFor`), and only to a workflow in
 * the version of the App that runs. The link holds the IDs only; the
 * record's history keeps every version before it. Refused with
 * `knowledge.invalid` for a record that isn't a designed workflow, and
 * recorded in the audit log.
 */
export const linkWorkflow = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> => {
  requirePlaybook(env);
  const { documentId, ifVersion, appId, workflowId } = knowledgeErrors.parse(
    "knowledge.invalid",
    linkInputSchema,
    input
  );
  const collection = await playbookCollection(env, person);
  requireWritable(env, person, collection);
  const db = drizzle(env.KNOWLEDGE);
  const document = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.collectionId, collection.id)
      )
    )
    .get();
  if (!document) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const stale = () =>
    knowledgeErrors.create("knowledge.conflict", {
      documentId: document.id,
      latestVersion: document.currentVersion,
    });
  if (ifVersion !== document.currentVersion) {
    throw stale();
  }
  // The version the link is made on, which the save then requires is
  // still current: nothing saved in between is lost.
  const text = await versionText(env, document.id, ifVersion);
  if (text === undefined) {
    throw stale();
  }
  const { type, frontmatter } = parseFrontmatter(document.path, text);
  if (type !== "workflow" || !("state" in frontmatter)) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: ["documentId: not a workflow record"],
    });
  }
  if (frontmatter.state !== "designed") {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: ["documentId: only a designed workflow links to an App workflow"],
    });
  }
  const app = await appContents(env, person, appId);
  if (!app.workflows.includes(workflowId)) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        `workflowId: the version of App ${appId} that runs has no workflow ${workflowId}`,
      ],
    });
  }
  return await writeVersion(env, personWriter(person), {
    collection,
    path: document.path,
    text: withFrontmatter(text, { app: { appId, workflowId } }),
    ifVersion,
    message: "Linked to its App workflow",
    restoredFrom: null,
    also: [
      outboxed(db, {
        actor: actorOf(person),
        action: "knowledge.workflow.linked",
        target: { type: "document", id: document.id },
        detail: { version: ifVersion + 1, appId, workflowId },
      }),
    ],
  });
};
