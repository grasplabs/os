import {
  knowledgeErrors,
  playbookCollectionId,
} from "@grasp-os/shared/knowledge";
import { log } from "@grasp-os/shared/log";
import { signalKinds, signalWindowDays } from "@grasp-os/shared/signals";
import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

import { improvementSignals } from "../db/core/schema.ts";
import { inList } from "../db/d1.ts";
import { documents, versions } from "../db/knowledge/schema.ts";
import { featureEnabled } from "../features.ts";
import { latestComputation, runsSince, workflowKey } from "../signals.ts";
import {
  FrontmatterError,
  parseFrontmatter,
  shortTextMax,
  snapshotMaxFigures,
  snapshotMaxHoursPerWeek,
  snapshotMaxSignals,
} from "./frontmatter.ts";

// What a snapshot freezes when the platform takes it (`takeSnapshot` in
// playbook.ts): each workflow record's hours a week, as drawn, as designed
// and as it runs, and the improvement signals of the App workflows the
// Playbook links to. Worked out here, once, and written into the snapshot:
// a later save of a workflow, a new run or a new day's signals never
// changes a snapshot's numbers, and a board page shows them as they were.
//
// A workflow's hours are its steps' times a week × minutes × people, over
// 60 (one person where none is said), as the workflow map shows them. As
// it runs, each run is one pass through its designed steps: the same
// sum, at the runs a week its App workflow was observed to start over the
// last `signalWindowDays` days.

/** Days of runs the observed numbers are from: the signals' window. */
export const snapshotWindowDays = signalWindowDays;

const dayMs = 24 * 60 * 60 * 1000;
const daysPerWeek = 7;
const minutesPerHour = 60;

/** Workflow records read at a time, with their text (up to 1 MB each). */
const recordsPerPage = 10;

/** The most earlier versions of a designed workflow read for its drawn one. */
const historyDepth = 50;

/** A step's numbers, as a workflow record keeps them. */
interface Step {
  numbers?: Partial<
    Record<
      "frequency" | "minutes" | "people",
      { value: number; basis: "estimated" | "observed" }
    >
  >;
}

/** A workflow record's fields a snapshot reads. */
interface Workflow {
  title?: string;
  state: "drawn" | "designed";
  team?: string;
  steps: Step[];
  app?: { appId: string; workflowId: string };
}

/**
 * Hours to a tenth, as the Playbook's numbers are shown, and no more than
 * a snapshot holds: steps with absurd numbers don't stop one being taken.
 */
const tenths = (hours: number): number =>
  Math.min(Math.round(hours * 10) / 10, snapshotMaxHoursPerWeek);

/** A title as a snapshot holds it: a short text. */
const short = (text: string): string => text.trim().slice(0, shortTextMax);

/**
 * The hours a week `steps` take, and whether every number they have was
 * observed; at `perWeek` times a week for each step, where given.
 */
export const hoursOf = (
  steps: readonly Step[],
  perWeek?: number
): { hoursPerWeek: number; basis: "estimated" | "observed" } => {
  let minutes = 0;
  for (const { numbers } of steps) {
    const times = perWeek ?? numbers?.frequency?.value ?? 0;
    minutes +=
      times * (numbers?.minutes?.value ?? 0) * (numbers?.people?.value ?? 1);
  }
  const all = steps.flatMap(({ numbers }) =>
    Object.values(numbers ?? {}).filter((number) => number !== undefined)
  );
  const observed =
    all.length > 0 && all.every(({ basis }) => basis === "observed");
  return {
    hoursPerWeek: tenths(minutes / minutesPerHour),
    basis: observed ? "observed" : "estimated",
  };
};

/** `text` as a workflow record, or undefined when it doesn't read as one. */
const workflowOf = (path: string, text: string): Workflow | undefined => {
  try {
    const { type, frontmatter } = parseFrontmatter(path, text);
    return type === "workflow" &&
      "state" in frontmatter &&
      "steps" in frontmatter
      ? frontmatter
      : undefined;
  } catch (error) {
    if (error instanceof FrontmatterError) {
      return undefined;
    }
    throw error;
  }
};

/** A workflow record at its current version. */
interface Current {
  id: string;
  path: string;
  title: string;
  version: number;
  workflow: Workflow;
}

/** Every workflow record in the Playbook, at its current version, by path. */
const currentWorkflows = async (db: DrizzleD1Database): Promise<Current[]> => {
  const found: Current[] = [];
  let after = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts after the last
    const rows = await db
      .select({
        id: documents.id,
        path: documents.path,
        title: documents.title,
        version: documents.currentVersion,
        text: versions.text,
      })
      .from(documents)
      .innerJoin(
        versions,
        and(
          eq(versions.documentId, documents.id),
          eq(versions.number, documents.currentVersion)
        )
      )
      .where(
        and(
          eq(documents.collectionId, playbookCollectionId),
          eq(documents.type, "workflow"),
          gt(documents.path, after)
        )
      )
      .orderBy(asc(documents.path))
      .limit(recordsPerPage);
    for (const { text, ...row } of rows) {
      const workflow = workflowOf(row.path, text);
      if (workflow === undefined) {
        // Saved text fit its type; under another release's schemas it may
        // not. The snapshot goes on without it.
        log.warn("snapshot.workflow_unreadable", { document: row.id });
      } else {
        found.push({ ...row, workflow });
      }
    }
    if (rows.length < recordsPerPage) {
      return found;
    }
    after = rows.at(-1)?.path ?? after;
  }
};

/**
 * The latest drawn version of the designed workflow `current`, looking
 * back at most `historyDepth` versions; undefined without one.
 */
const drawnVersion = async (
  db: DrizzleD1Database,
  current: Current
): Promise<{ version: number; workflow: Workflow } | undefined> => {
  const oldest = Math.max(1, current.version - historyDepth);
  let before = current.version;
  while (before > oldest) {
    // oxlint-disable-next-line no-await-in-loop -- newest first, until the drawn one
    const rows = await db
      .select({ number: versions.number, text: versions.text })
      .from(versions)
      .where(
        and(
          eq(versions.documentId, current.id),
          lt(versions.number, before),
          gt(versions.number, oldest - 1)
        )
      )
      .orderBy(desc(versions.number))
      .limit(recordsPerPage);
    for (const { number, text } of rows) {
      const workflow = workflowOf(current.path, text);
      if (workflow?.state === "drawn") {
        return { version: number, workflow };
      }
    }
    if (rows.length < recordsPerPage) {
      return undefined;
    }
    before = rows.at(-1)?.number ?? oldest;
  }
  return undefined;
};

/** The title of each team record in the Playbook, by path. */
const teamTitles = async (
  db: DrizzleD1Database
): Promise<Map<string, string>> => {
  const rows = await db
    .select({ path: documents.path, title: documents.title })
    .from(documents)
    .where(
      and(
        eq(documents.collectionId, playbookCollectionId),
        eq(documents.type, "team")
      )
    );
  return new Map(rows.map(({ path, title }) => [path, title]));
};

/** An improvement signal as a snapshot freezes it. */
interface FrozenSignal {
  path: string;
  kind: string;
  value: number;
}

/**
 * The current improvement signals of the App workflows `linked` (by
 * `workflowKey`, to the path of the record linked to it), of the Apps
 * `apps`: each kind's
 * highest value for each, with neither its subject nor its evidence, in
 * the order of the kinds, highest first, at most `snapshotMaxSignals`.
 * None while the signals are switched off.
 */
const linkedSignals = async (
  env: Env,
  linked: ReadonlyMap<string, string>,
  apps: readonly string[]
): Promise<FrozenSignal[]> => {
  if (!featureEnabled(env, "improvement_signals") || linked.size === 0) {
    return [];
  }
  const rows = await drizzle(env.DB)
    .select({
      appId: improvementSignals.appId,
      workflowId: improvementSignals.workflowId,
      kind: improvementSignals.kind,
      value: improvementSignals.value,
    })
    .from(improvementSignals)
    .where(
      and(
        eq(improvementSignals.computation, latestComputation),
        inList(improvementSignals.appId, apps)
      )
    );
  const highest = new Map<string, FrozenSignal>();
  for (const { appId, workflowId, kind, value } of rows) {
    const path = linked.get(workflowKey(appId, workflowId));
    const key = JSON.stringify([path, kind]);
    if (path !== undefined && value > (highest.get(key)?.value ?? -1)) {
      highest.set(key, { path, kind, value });
    }
  }
  const order: readonly string[] = signalKinds;
  return [...highest.values()]
    .toSorted(
      (a, b) =>
        order.indexOf(a.kind) - order.indexOf(b.kind) ||
        b.value - a.value ||
        a.path.localeCompare(b.path)
    )
    .slice(0, snapshotMaxSignals);
};

/** A version of a workflow record, read as one. */
interface Version {
  version: number;
  workflow: Workflow;
}

/** The drawn version of `record`: itself, or a designed one's latest drawn. */
const drawnOf = async (
  db: DrizzleD1Database,
  record: Current
): Promise<Version | undefined> =>
  record.workflow.state === "designed"
    ? await drawnVersion(db, record)
    : { version: record.version, workflow: record.workflow };

/**
 * What a snapshot freezes of `record`: its title, its team's title (by
 * `teams`), its hours drawn (`drawn`), designed, and as it runs, by the
 * runs its App workflow started in the window (`runs`).
 */
const figuresOf = (
  record: Current,
  drawn: Version | undefined,
  teams: ReadonlyMap<string, string>,
  runs: ReadonlyMap<string, { runs: number }>
): Record<string, unknown> => {
  const { workflow, version } = record;
  const teamTitle =
    workflow.team === undefined ? undefined : teams.get(workflow.team);
  const { app } = workflow;
  const started =
    app === undefined
      ? 0
      : (runs.get(workflowKey(app.appId, app.workflowId))?.runs ?? 0);
  const weeks = snapshotWindowDays / daysPerWeek;
  return {
    path: record.path,
    title: short(workflow.title ?? record.title),
    ...(teamTitle === undefined ? {} : { team: short(teamTitle) }),
    state: workflow.state,
    ...(drawn === undefined
      ? {}
      : {
          drawn: { version: drawn.version, ...hoursOf(drawn.workflow.steps) },
        }),
    ...(workflow.state === "designed"
      ? { designed: { version, ...hoursOf(workflow.steps) } }
      : {}),
    ...(app === undefined || started === 0
      ? {}
      : {
          running: {
            ...app,
            runs: started,
            hoursPerWeek: hoursOf(workflow.steps, started / weeks).hoursPerWeek,
          },
        }),
  };
};

/** What a snapshot freezes, as `snapshotSchema` in frontmatter.ts reads it. */
export interface SnapshotFigures {
  /** The workflow versions it froze, as `[{ path, version }]`. */
  workflows: { path: string; version: number }[];
  figures: {
    windowDays: number;
    workflows: Record<string, unknown>[];
    signals: FrozenSignal[];
  };
}

/**
 * What a snapshot taken at `now` freezes: every workflow record in the
 * Playbook, at its current version and a designed one's latest drawn
 * version, with their hours; for a designed one linked to an App workflow
 * with runs in the window, its hours as it runs; and the current signals
 * of the linked App workflows. Refused with `knowledge.invalid` when the
 * Playbook has more workflows than one snapshot holds.
 */
export const snapshotFigures = async (
  env: Env,
  now: Date
): Promise<SnapshotFigures> => {
  const db = drizzle(env.KNOWLEDGE);
  const [current, teams, runs] = await Promise.all([
    currentWorkflows(db),
    teamTitles(db),
    runsSince(
      drizzle(env.DB),
      new Date(now.getTime() - snapshotWindowDays * dayMs)
    ),
  ]);
  if (current.length > snapshotMaxFigures) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        `workflows: a snapshot holds at most ${snapshotMaxFigures} workflows, and the Playbook has ${current.length}`,
      ],
    });
  }
  const linked = new Map<string, string>();
  const apps = new Set<string>();
  const frozen: SnapshotFigures["workflows"] = [];
  const workflows: Record<string, unknown>[] = [];
  for (const record of current) {
    // oxlint-disable-next-line no-await-in-loop -- one record's history at a time
    const drawn = await drawnOf(db, record);
    const { app } = record.workflow;
    if (app !== undefined) {
      const key = workflowKey(app.appId, app.workflowId);
      if (!linked.has(key)) {
        linked.set(key, record.path);
        apps.add(app.appId);
      }
    }
    if (drawn !== undefined) {
      frozen.push({ path: record.path, version: drawn.version });
    }
    if (record.workflow.state === "designed") {
      frozen.push({ path: record.path, version: record.version });
    }
    workflows.push(figuresOf(record, drawn, teams, runs));
  }
  return {
    workflows: frozen,
    figures: {
      windowDays: snapshotWindowDays,
      workflows,
      signals: await linkedSignals(env, linked, [...apps]),
    },
  };
};
