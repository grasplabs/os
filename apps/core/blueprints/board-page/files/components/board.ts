// A snapshot as the board page reads it, and what the page shows of it:
// where the hours go now, before and after for each designed workflow,
// and the improvement signals, each cut to what fits on one page. Only
// from what the snapshot froze, so the page shows the numbers as they
// were when it was taken.

export type Basis = "estimated" | "observed";

/** A version of a workflow, and the hours a week its steps take. */
export interface VersionHours {
  version: number;
  hoursPerWeek: number;
  basis: Basis;
}

/** What a snapshot froze of one workflow. */
export interface WorkflowFigures {
  path: string;
  title: string;
  team?: string;
  state: "drawn" | "designed";
  drawn?: VersionHours;
  designed?: VersionHours;
  /** Its designed steps at the runs a week observed. */
  running?: {
    appId: string;
    workflowId: string;
    runs: number;
    hoursPerWeek: number;
  };
}

/** An improvement signal of a linked App workflow, by its record. */
export interface SignalFigure {
  path: string;
  kind: string;
  value: number;
}

/** A snapshot's fields, as the Playbook reads them. */
export interface SnapshotRecord {
  title?: string;
  date?: string;
  maturity?: number;
  decisionNeeded?: string;
  figures?: {
    windowDays: number;
    workflows: WorkflowFigures[];
    signals: SignalFigure[];
  };
}

/** Rows of each list the page shows, so it fits on one page. */
export const rowsShown = 5;

/** The highest maturity level. */
export const maturityLevels = 5;

/**
 * A snapshot record's fields: the server reads only documents of type
 * `snapshot`, which the Playbook checked against the page's snapshot
 * type (app/records.json) on save, and reads back with it.
 */
export const snapshotRecordOf = (
  record: Record<string, unknown>
): SnapshotRecord => record;

/**
 * The hours a week a workflow takes now: as it runs, once it does; as it
 * was drawn until then (designed but not running, it is still done that
 * way); as designed when no drawn version was found.
 */
export const hoursNow = (workflow: WorkflowFigures): number =>
  workflow.running?.hoursPerWeek ??
  workflow.drawn?.hoursPerWeek ??
  workflow.designed?.hoursPerWeek ??
  0;

/** A workflow and the hours a week it takes now. */
export interface HoursRow {
  path: string;
  title: string;
  team?: string;
  hoursPerWeek: number;
}

/** Where the hours go: the workflows taking most now, most first. */
export const topByHours = (workflows: readonly WorkflowFigures[]): HoursRow[] =>
  workflows
    .map(({ path, title, team, ...rest }) => ({
      path,
      title,
      ...(team === undefined ? {} : { team }),
      hoursPerWeek: hoursNow({ path, title, ...rest }),
    }))
    .filter(({ hoursPerWeek }) => hoursPerWeek > 0)
    .toSorted(
      (a, b) =>
        b.hoursPerWeek - a.hoursPerWeek || a.title.localeCompare(b.title)
    )
    .slice(0, rowsShown);

/**
 * A designed workflow before and after: drawn, and as it runs (observed)
 * or, until it does, as designed (expected).
 */
export interface BeforeAfterRow {
  path: string;
  title: string;
  before: number;
  after: number;
  /** Observed in runs, or expected from the design. */
  from: "observed" | "expected";
}

/**
 * Before and after for each designed workflow with a drawn version,
 * saving most first: running ones by their observed hours.
 */
export const beforeAndAfter = (
  workflows: readonly WorkflowFigures[]
): BeforeAfterRow[] =>
  workflows
    .flatMap(({ path, title, drawn, designed, running }) => {
      if (drawn === undefined || designed === undefined) {
        return [];
      }
      return [
        {
          path,
          title,
          before: drawn.hoursPerWeek,
          after: running?.hoursPerWeek ?? designed.hoursPerWeek,
          from:
            running === undefined
              ? ("expected" as const)
              : ("observed" as const),
        },
      ];
    })
    .toSorted(
      (a, b) =>
        b.before - b.after - (a.before - a.after) ||
        a.title.localeCompare(b.title)
    )
    .slice(0, rowsShown);

/** What the page leads with. */
export interface Headline {
  /** Hours a week every workflow takes now. */
  hoursNow: number;
  /** Hours a week the running workflows save against their drawn versions. */
  savedRunning: number;
  running: number;
  workflows: number;
}

/** The headline numbers of `workflows`. */
export const headlineOf = (workflows: readonly WorkflowFigures[]): Headline => {
  let now = 0;
  let saved = 0;
  let running = 0;
  for (const workflow of workflows) {
    now += hoursNow(workflow);
    if (workflow.running !== undefined) {
      running += 1;
      saved += Math.max(
        0,
        (workflow.drawn?.hoursPerWeek ?? 0) - workflow.running.hoursPerWeek
      );
    }
  }
  return {
    hoursNow: Math.round(now * 10) / 10,
    savedRunning: Math.round(saved * 10) / 10,
    running,
    workflows: workflows.length,
  };
};

const msPerHour = 60 * 60 * 1000;
const hoursPerDay = 24;

/** How long, from milliseconds: in days from two days on, else in hours. */
const waited = (ms: number): string => {
  const hours = ms / msPerHour;
  return hours >= 2 * hoursPerDay
    ? `${Math.round(hours / hoursPerDay)} days`
    : `${Math.round(hours)} hours`;
};

/** An improvement signal in plain words, without its workflow. */
export const signalText = ({ kind, value }: SignalFigure): string => {
  switch (kind) {
    case "waiting_for_person": {
      return `Waits up to ${waited(value)} for a person to decide`;
    }
    case "failing_step": {
      return `${value} runs failed at a step`;
    }
    case "correction": {
      return `${value} proposals were rejected`;
    }
    case "cost_per_run": {
      return `$${value.toFixed(2)} of model calls a run`;
    }
    case "unanswered_question": {
      return `A question went unanswered ${value} times`;
    }
    default: {
      return `${kind.replaceAll("_", " ")}: ${value}`;
    }
  }
};

/** A signal as the page lists it: the workflow's title and what it says. */
export interface SignalRow {
  key: string;
  workflow: string;
  text: string;
}

/** The first signals, in the snapshot's order, with their workflow's title. */
export const signalRows = (
  signals: readonly SignalFigure[],
  workflows: readonly WorkflowFigures[]
): SignalRow[] => {
  const titles = new Map(workflows.map(({ path, title }) => [path, title]));
  return signals.slice(0, rowsShown).map((signal) => ({
    key: `${signal.path}:${signal.kind}`,
    workflow: titles.get(signal.path) ?? signal.path,
    text: signalText(signal),
  }));
};

/** Hours, as the page shows them: `12.5 h`. */
export const formatHours = (hours: number): string =>
  `${(Math.round(hours * 10) / 10).toLocaleString("en", { maximumFractionDigits: 1 })} h`;
