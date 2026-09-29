import { actorOf } from "@grasp-os/shared/audit";
import { isExpectedError } from "@grasp-os/shared/errors";
import {
  appIdSchema,
  documentIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { PermissionId } from "@grasp-os/shared/ids";
import {
  documentPathSchema,
  knowledgeErrors,
  playbookCollectionId,
  playbookRecordTypes,
} from "@grasp-os/shared/knowledge";
import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import type { Authority, WorkContext } from "@grasp-os/shared/permissions";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { Person } from "../app-access.ts";
import { appContents } from "../apps.ts";
import { outboxed } from "../audit-outbox.ts";
import { collections, documents } from "../db/knowledge/schema.ts";
import { requireFeature } from "../features.ts";
import {
  ensureCollection,
  isWritable,
  requireWritable,
} from "./collections.ts";
import type { CollectionRow } from "./collections.ts";
import { findByPath, keptFieldsOf, writeVersion } from "./documents.ts";
import { parseFrontmatter, withFrontmatter } from "./frontmatter.ts";
import { noDeclaredTypes } from "./record-types.ts";
import {
  delegateWriter,
  lastCheckOf,
  recordText,
  versionText,
  versionWriter,
} from "./records.ts";
import type { RecordWriter } from "./records.ts";
import { snapshotFigures } from "./snapshots.ts";

// The Playbook: the company's records (its vision, teams, people, tools,
// what people said, its workflows drawn and designed, snapshots, the plan,
// decisions and rules) as typed documents in one collection per
// deployment. Records are documents like any other: saved through the
// same pipeline, with versions, search, links and purges; their
// frontmatter schemas are in frontmatter.ts.
//
// These helpers are how the Playbook Apps and the agent write them: a
// record as data and a Markdown body, the link from a designed workflow
// to the App workflow built from it, and a snapshot the platform takes
// (snapshots.ts). They are behind the `playbook` flag; reads go through
// Knowledge as for any document.
//
// A person saves and links as themselves. An App (its server code, knowledge/app-binding.ts)
// does it for the person whose call it runs in, as a delegate: only under
// a permission to write the Playbook, only what that person may do
// themselves (so only for an admin), and never from a context that read
// restricted data, which the Playbook, read by everyone, would pass on.

/** A person, saving a record themselves. */
const personRecordWriter = (person: Identity): RecordWriter => ({
  person,
  actor: actorOf(person),
});

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

/** The Playbook collection, if it exists yet. */
const storedPlaybook = async (env: Env): Promise<CollectionRow | undefined> =>
  await drizzle(env.KNOWLEDGE)
    .select()
    .from(collections)
    .where(eq(collections.id, playbookCollectionId))
    .get();

/**
 * The Playbook collection, created for `person` (by `actor`) if they are
 * an admin and it doesn't exist yet (they own it then; every admin can
 * change it). `knowledge.not_found` for anyone else while it doesn't
 * exist.
 */
export const playbookCollection = async (
  env: Env,
  { person, actor, detail }: RecordWriter
): Promise<CollectionRow> => {
  requirePlaybook(env);
  if (isAdmin(person.role)) {
    return await ensureCollection(
      env,
      playbookCollectionRow(person.userId),
      actor,
      detail
    );
  }
  const found = await storedPlaybook(env);
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
 * part of it: `linkWorkflow` sets that, and a save keeps it. Nor is what
 * a snapshot froze when the platform took it: `takeSnapshot` sets that,
 * and a save keeps it.
 */
const recordInputSchema = z.strictObject({
  path: documentPathSchema,
  ifVersion: z.int().min(0),
  record: z
    .looseObject({ type: recordTypeSchema })
    .refine((record) => !("app" in record), {
      path: ["app"],
      message: "Link a workflow to an App workflow with linkWorkflow",
    })
    .refine((record) => !("figures" in record), {
      path: ["figures"],
      message: "Only a snapshot the platform takes has figures: takeSnapshot",
    }),
  body: z.string(),
  /** What changed, for the history. */
  message: z.string().trim().max(500).optional(),
});

/**
 * What a save of a `type` record keeps from the saved `text` at `path`
 * when that was a `type` record too, whatever the record it saves says:
 * only the platform writes these. A
 * workflow keeps the App workflow it links to (`linkWorkflow`); a
 * snapshot the platform took (`takeSnapshot`) keeps what it froze, its
 * date, maturity, workflow versions and figures. Saved text fits its
 * type: the save pipeline checked it.
 */
const keptFrom = (
  type: string,
  path: string,
  text: string
): Record<string, unknown> => {
  // Only these types have fields the platform writes: any other save
  // doesn't read the text it goes over.
  if (type !== "workflow" && type !== "snapshot") {
    return {};
  }
  const saved = parseFrontmatter(path, text);
  if (saved.type !== type) {
    return {};
  }
  const { frontmatter } = saved;
  if ("app" in frontmatter && frontmatter.app) {
    return { app: frontmatter.app };
  }
  if ("figures" in frontmatter && frontmatter.figures) {
    const { date, maturity, workflows, figures } = frontmatter;
    return {
      date,
      ...(maturity === undefined ? {} : { maturity }),
      workflows,
      figures,
    };
  }
  return {};
};

/** A record to write, its input checked. */
type RecordInput = z.output<typeof recordInputSchema>;

/**
 * Writes `record` as `writer`, from `ifVersion` of `path`, keeping what
 * only the platform writes of the version it goes over (`keptFrom`), or,
 * for the platform's own write (`setsKept`), setting them as `record`
 * has them (`keptFieldsOf`).
 */
const writeRecord = async (
  env: Env,
  writer: RecordWriter,
  { path, ifVersion, record, body, message }: RecordInput,
  setsKept = false
): Promise<DocumentSummary> => {
  const collection = await playbookCollection(env, writer);
  requireWritable(env, writer.person, collection);
  const db = drizzle(env.KNOWLEDGE);
  const existing =
    ifVersion === 0 ? undefined : await findByPath(db, collection.id, path);
  // Only from the current version: from any other, the save below refuses
  // it as a conflict, and nothing older is carried into it.
  const previous =
    existing?.currentVersion === ifVersion
      ? await versionText(env, existing.id, ifVersion)
      : undefined;
  const kept =
    previous === undefined ? {} : keptFrom(record.type, path, previous);
  const text = recordText({ ...record, ...kept }, body);
  return await writeVersion(env, versionWriter(writer), {
    collection,
    path,
    text,
    ifVersion,
    message: message === undefined || message === "" ? null : message,
    restoredFrom: null,
    ...(setsKept ? { sets: keptFieldsOf(path, text, noDeclaredTypes) } : {}),
    ...lastCheckOf(writer),
  });
};

/** Saves a record as `writer` (see `saveRecord`). */
const saveRecordAs = async (
  env: Env,
  writer: RecordWriter,
  input: unknown
): Promise<DocumentSummary> => {
  requirePlaybook(env);
  return await writeRecord(
    env,
    writer,
    knowledgeErrors.parse("knowledge.invalid", recordInputSchema, input)
  );
};

/**
 * Creates or updates a Playbook record, as `person`, through the save
 * pipeline: refused as any save is (`knowledge.invalid` when the record
 * doesn't fit its type, `knowledge.conflict` when `ifVersion` isn't
 * current), and only by those who may change the Playbook (its admins).
 * A workflow keeps the App workflow the version it was edited from links
 * to, and a snapshot the platform took keeps what it froze.
 */
export const saveRecord = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> =>
  await saveRecordAs(env, personRecordWriter(person), input);

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

/** Links a workflow record as `writer` (see `linkWorkflow`). */
const linkWorkflowAs = async (
  env: Env,
  writer: RecordWriter,
  input: unknown
): Promise<DocumentSummary> => {
  requirePlaybook(env);
  const { documentId, ifVersion, appId, workflowId } = knowledgeErrors.parse(
    "knowledge.invalid",
    linkInputSchema,
    input
  );
  const collection = await playbookCollection(env, writer);
  requireWritable(env, writer.person, collection);
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
  const app = await appContents(env, writer.person, appId);
  if (!app.workflows.includes(workflowId)) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        `workflowId: the version of App ${appId} that runs has no workflow ${workflowId}`,
      ],
    });
  }
  return await writeVersion(env, versionWriter(writer), {
    collection,
    path: document.path,
    text: withFrontmatter(text, { app: { appId, workflowId } }),
    ifVersion,
    message: "Linked to its App workflow",
    restoredFrom: null,
    // The one write that sets it: every other save keeps it.
    sets: { app: { appId, workflowId } },
    ...lastCheckOf(writer),
    also: [
      outboxed(db, {
        actor: writer.actor,
        action: "knowledge.workflow.linked",
        target: { type: "document", id: document.id },
        detail: {
          ...writer.detail,
          version: ifVersion + 1,
          appId,
          workflowId,
        },
      }),
    ],
  });
};

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
): Promise<DocumentSummary> =>
  await linkWorkflowAs(env, personRecordWriter(person), input);

/** An App's or agent's writer of the Playbook (`delegateWriter`). */
const playbookWriter = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  permissionId: PermissionId
): Promise<RecordWriter> => {
  requirePlaybook(env);
  return await delegateWriter(
    env,
    authority,
    context,
    permissionId,
    playbookCollectionId
  );
};

/**
 * `saveRecord`, by an App or agent for the person `authority` names, under
 * the permission `permissionId` (see `delegateWriter`). The version is
 * that person's, and the audit log names the App or agent.
 */
export const saveRecordAsDelegate = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  permissionId: PermissionId,
  input: unknown
): Promise<DocumentSummary> =>
  await saveRecordAs(
    env,
    await playbookWriter(env, authority, context, permissionId),
    input
  );

/**
 * `linkWorkflow`, by an App or agent for the person `authority` names,
 * under the permission `permissionId` (see `delegateWriter`): only to a
 * workflow of an App that person may use.
 */
export const linkWorkflowAsDelegate = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  permissionId: PermissionId,
  input: unknown
): Promise<DocumentSummary> =>
  await linkWorkflowAs(
    env,
    await playbookWriter(env, authority, context, permissionId),
    input
  );

/**
 * A snapshot to take (`takeSnapshot`): the maturity it records, from 0 to
 * 5; its title (`Snapshot <date>` when none); the decision it asks for;
 * and its Markdown, such as the board page's narrative.
 */
export const snapshotInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).optional(),
  maturity: z.int().min(0).max(5),
  decisionNeeded: z.string().trim().max(1000).optional(),
  body: z.string().default(""),
});
export type SnapshotInput = z.input<typeof snapshotInputSchema>;

/** Takes a snapshot as `writer` (see `takeSnapshotAsDelegate`). */
const takeSnapshotAs = async (
  env: Env,
  writer: RecordWriter,
  input: unknown
): Promise<DocumentSummary> => {
  requirePlaybook(env);
  const { title, maturity, decisionNeeded, body } = knowledgeErrors.parse(
    "knowledge.invalid",
    snapshotInputSchema,
    input
  );
  // Refused before the Playbook's workflows and runs are read.
  requireWritable(env, writer.person, await playbookCollection(env, writer));
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const { workflows, figures } = await snapshotFigures(env, now);
  // Its own path each time, by the time it was taken, so paths sort as
  // snapshots were taken (`2026-09-28T101530123Z`, after an older path of
  // that day, `2026-09-28-…`); two taken at once are two snapshots.
  const taken = `${date}T${now.toISOString().slice(11, 23).replaceAll(/[:.]/gu, "")}Z`;
  return await writeRecord(
    env,
    writer,
    {
      path: `snapshots/${taken}-${crypto.randomUUID().slice(0, 8)}.md`,
      ifVersion: 0,
      record: {
        type: "snapshot",
        title: title ?? `Snapshot ${date}`,
        date,
        maturity,
        workflows,
        figures,
        ...(decisionNeeded === undefined || decisionNeeded === ""
          ? {}
          : { decisionNeeded }),
      },
      body,
      message: "Taken",
    },
    // The one write that sets what a snapshot freezes.
    true
  );
};

/**
 * Takes a dated snapshot of the Playbook, by an App or agent for the
 * person `authority` names, under the permission `permissionId` (see
 * `delegateWriter`): a new `snapshot` record that freezes every workflow
 * record at its current version (and a designed one's drawn version),
 * with the hours each takes, drawn, designed and as it runs by the runs
 * observed, and the improvement signals of the App workflows they link to
 * (snapshots.ts). Saving it again keeps what it froze (`saveRecord`).
 */
export const takeSnapshotAsDelegate = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  permissionId: PermissionId,
  input: unknown
): Promise<DocumentSummary> =>
  await takeSnapshotAs(
    env,
    await playbookWriter(env, authority, context, permissionId),
    input
  );

/**
 * Whether `saveRecordAsDelegate` and `linkWorkflowAsDelegate` would write
 * for the person `authority` names, under `permissionId`, in `context`:
 * the same checks (`delegateWriter`, then `requireWritable` on the
 * Playbook, or on the one their first save would set up), for showing
 * only the changes core would take. Writes nothing, and records nothing:
 * each write is checked and recorded as it is made.
 */
export const canWriteAsDelegate = async (
  env: Env,
  authority: Authority,
  context: WorkContext,
  permissionId: PermissionId
): Promise<boolean> => {
  let person: Person;
  try {
    ({ person } = await playbookWriter(env, authority, context, permissionId));
  } catch (error) {
    if (isExpectedError(error)) {
      return false;
    }
    throw error;
  }
  const collection =
    (await storedPlaybook(env)) ?? playbookCollectionRow(person.userId);
  return isWritable(env, person, collection);
};
