// What a snapshot freezes when the board page takes it: each workflow
// record's hours a week, as drawn, as designed and as it runs, and the
// improvement signals of the App workflows the Playbook links to. Worked
// out here, once, and written into the snapshot, which only the page's
// `take` may set (`app/records.json`): a later save of a workflow, a new
// run or a new day's signals never changes a snapshot's numbers, and the
// page shows them as they were.
//
// A workflow's hours are its steps' times a week × minutes × people, over
// 60 (one person where none is said), as the workflow map shows them. As
// it runs, each run is one pass through its designed steps: the same sum,
// at the runs a week its App workflow was observed to start over the last
// `windowDays` days, which the platform's statistics count.

/** Whoever the method runs for, as the platform passes it. */
export interface Caller {
  userId: string;
}

/** A document, without its text. */
export interface Summary {
  id: string;
  path: string;
  title: string;
  type: string;
  currentVersion: number;
}

/** A record at its current version, as a page of records lists it. */
interface RecordSummary extends Summary {
  record: Record<string, unknown>;
}

/** A document read as a record: its frontmatter as data, and its Markdown. */
export interface RecordRead extends Summary {
  record: Record<string, unknown>;
  body: string;
  version: { number: number };
}

/** The Playbook, as the App's permission gives it. */
export interface Playbook {
  listDocuments: (
    caller: Caller,
    options?: { after?: string; limit?: number }
  ) => Promise<{ documents: Summary[] }>;
  listRecords: (
    caller: Caller,
    options?: { after?: string; limit?: number; type?: string }
  ) => Promise<{
    records: RecordSummary[];
    unreadable: Summary[];
    next: string | null;
  }>;
  getRecord: (
    caller: Caller,
    documentId: string,
    version?: number
  ) => Promise<RecordRead>;
  saveRecord: (caller: Caller, input: unknown) => Promise<Summary>;
  canWrite: (caller: Caller) => Promise<boolean>;
}

/** A group of a statistics read: its dimensions, added up. */
interface StatisticGroup {
  dimensions: Record<string, string | null>;
  count: number;
  max: number;
}

/** A statistics read, as the platform takes it. */
interface StatisticQuery {
  measure: string;
  days: number;
  where?: Record<string, string>;
  /** The Apps one platform read counts, grouped by `app`. */
  apps?: string[];
  /** Where in the groups the page starts. */
  offset?: number;
  /** When the window ends: the snapshot's time, the same for every page. */
  until?: string;
  groupBy?: string[];
}

/** The App's statistics, which every App has. */
export interface Statistics {
  read: (
    caller: Caller,
    query: StatisticQuery
  ) => Promise<{
    groups: StatisticGroup[];
    truncated: boolean;
    /** Of `apps`, those the caller may not see, or that are gone. */
    unavailable?: string[];
    /** For improvement signals: the computation it read, null for none. */
    computation?: string | null;
  }>;
}

/** Most Apps one platform read counts (the platform's bound). */
const appsPerRead = 100;

/** Most groups one read answers (the platform's bound): one page. */
const groupsPerPage = 100;

/**
 * Most pages of one measure a snapshot reads. More groups than that
 * refuse the snapshot (`board.figures_incomplete`) rather than freeze
 * part of them: far more than a Playbook's 250 workflows make.
 */
const maxPages = 5;

/** Days of runs the observed numbers are from: the signals' window. */
export const windowDays = 30;

const daysPerWeek = 7;
const minutesPerHour = 60;

/** Most hours a week a snapshot holds for one workflow. */
const maxHoursPerWeek = 100_000;

/** Longest title a snapshot holds. */
const titleMax = 200;

/** Most workflows one snapshot's figures hold. */
export const maxFigures = 250;

/** Most improvement signals one snapshot holds. */
const maxSignals = 50;

/** Records one page lists. */
const pageSize = 20;

/** The order the platform ranks improvement signals' kinds in. */
const kindOrder = [
  "waiting_for_person",
  "failing_step",
  "correction",
  "cost_per_run",
  "unanswered_question",
];

type Basis = "estimated" | "observed";

/** A step's numbers, as a workflow record keeps them. */
interface Step {
  numbers?: Partial<
    Record<"frequency" | "minutes" | "people", { value: number; basis: Basis }>
  >;
}

/** A workflow record's fields a snapshot reads. */
interface Workflow {
  title?: string;
  state: "drawn" | "designed";
  team?: string;
  steps: Step[];
  app?: { appId: string; workflowId: string };
  /** For a designed one, the version of it last drawn (the map keeps it). */
  drawnVersion?: number;
}

/** A workflow record at its current version. */
interface Current {
  id: string;
  path: string;
  title: string;
  version: number;
  workflow: Workflow;
}

/** A version of a workflow record, read as one. */
interface Version {
  version: number;
  workflow: Workflow;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A workflow record's fields, or undefined for any other record: the
 * Playbook checked each against the map's schema on save, and reads them
 * back with it, so a record of type `workflow` has these.
 */
const workflowOf = (record: Record<string, unknown>): Workflow | undefined => {
  const { type, state, steps, title, team, app, drawnVersion } = record;
  if (type !== "workflow" || (state !== "drawn" && state !== "designed")) {
    return undefined;
  }
  return {
    state,
    steps: Array.isArray(steps) ? steps.filter(isObject) : [],
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof team === "string" ? { team } : {}),
    ...(typeof drawnVersion === "number" ? { drawnVersion } : {}),
    ...(isObject(app) &&
    typeof app.appId === "string" &&
    typeof app.workflowId === "string"
      ? { app: { appId: app.appId, workflowId: app.workflowId } }
      : {}),
  };
};

/** Hours to a tenth, and no more than a snapshot holds. */
const tenths = (hours: number): number =>
  Math.min(Math.round(hours * 10) / 10, maxHoursPerWeek);

/** A title as a snapshot holds it. */
const short = (text: string): string => text.trim().slice(0, titleMax);

/**
 * The hours a week `steps` take, and whether every number they have was
 * observed; at `perWeek` times a week for each step, where given.
 */
export const hoursOf = (
  steps: readonly Step[],
  perWeek?: number
): { hoursPerWeek: number; basis: Basis } => {
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

/** Every record of `type` in the Playbook, a page (one read) at a time. */
const recordsOf = async (
  playbook: Playbook,
  caller: Caller,
  type: string
): Promise<RecordSummary[]> => {
  const all: RecordSummary[] = [];
  let after: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts after the last
    const page = await playbook.listRecords(caller, {
      ...(after === undefined ? {} : { after }),
      limit: pageSize,
      type,
    });
    all.push(...page.records);
    if (page.next === null) {
      return all;
    }
    after = page.next;
  }
};

/** The code a refusal carries, if any. */
const codeOf = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : undefined;

/**
 * The version of the designed workflow `current` last drawn, as its record
 * names it (`drawnVersion`, which the map's save keeps): one read.
 * Undefined without one, and when that version no longer reads as a drawn
 * workflow (`knowledge.invalid`, under another version of the map's
 * types, say).
 */
const drawnVersion = async (
  playbook: Playbook,
  caller: Caller,
  current: Current
): Promise<Version | undefined> => {
  const number = current.workflow.drawnVersion;
  if (number === undefined) {
    return undefined;
  }
  try {
    const earlier = await playbook.getRecord(caller, current.id, number);
    const workflow = workflowOf(earlier.record);
    return workflow?.state === "drawn"
      ? { version: number, workflow }
      : undefined;
  } catch (error) {
    if (codeOf(error) === "knowledge.invalid") {
      return undefined;
    }
    throw error;
  }
};

/**
 * Refusals of a statistics read that leave a snapshot without what runs:
 * an App whose runs the caller may not see, or no longer may use, or a
 * read another release refuses.
 */
const expectedRefusals: ReadonlySet<string> = new Set([
  "permission.denied",
  "permission.person_inactive",
  "app.not_found",
  "role.forbidden",
  "statistics.invalid",
]);

/** A key for an App workflow. */
const keyOf = (appId: string, workflowId: string): string =>
  JSON.stringify([appId, workflowId]);

/** Every group of a read, page by page, as `allGroups` reads them. */
interface Pages {
  groups: StatisticGroup[];
  /** Of its Apps, those the caller may not see, or that are gone. */
  unavailable: string[];
  /** The improvement-signal computations its pages read: one, or none. */
  computations: Set<string | null>;
}

/** Refuses a snapshot whose figures would be incomplete, and why. */
const incomplete = (why: string): Error =>
  Object.assign(
    new Error(`${why}, so the snapshot's figures would be incomplete.`),
    { code: "board.figures_incomplete" }
  );

/**
 * Every group `query` has, page by page, the Apps of it the caller may not
 * see (`unavailable`), and the signal computations its pages read. Its
 * `until` holds the window still, and the platform orders groups by their
 * values, so no page overlaps or skips another as runs start meanwhile.
 * Refused with `board.figures_incomplete` past `maxPages`, so a snapshot
 * never freezes part of them.
 */
const allGroups = async (
  statistics: Statistics,
  caller: Caller,
  query: StatisticQuery
): Promise<Pages> => {
  const groups: StatisticGroup[] = [];
  const computations = new Set<string | null>();
  for (let page = 0; page < maxPages; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one page after another
    const answer = await statistics.read(caller, {
      ...query,
      offset: page * groupsPerPage,
    });
    groups.push(...answer.groups);
    if (answer.computation !== undefined) {
      computations.add(answer.computation);
    }
    if (!answer.truncated) {
      return { groups, unavailable: answer.unavailable ?? [], computations };
    }
  }
  throw incomplete(
    `The platform counts more than ${maxPages * groupsPerPage} groups of ${query.measure} for the Apps this Playbook links to`
  );
};

/** `items` in runs of at most `size`. */
const chunksOf = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size)
  );

/**
 * `query` read for each of `chunks` of Apps (`allGroups`), each chunk's
 * pages in turn. A chunk refused as expected (not the caller's to use)
 * has all its Apps `unavailable`; any other
 * failure fails the snapshot.
 */
const readChunks = async (
  statistics: Statistics,
  caller: Caller,
  chunks: readonly string[][],
  query: StatisticQuery
): Promise<Pages> => {
  const read: Pages = { groups: [], unavailable: [], computations: new Set() };
  for (const chunk of chunks) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few chunks, one at a time
      const pages = await allGroups(statistics, caller, {
        ...query,
        apps: chunk,
      });
      read.groups.push(...pages.groups);
      read.unavailable.push(...pages.unavailable);
      for (const computation of pages.computations) {
        read.computations.add(computation);
      }
    } catch (error) {
      const code = codeOf(error);
      if (code === undefined || !expectedRefusals.has(code)) {
        throw error;
      }
      read.unavailable.push(...chunk);
    }
  }
  return read;
};

/**
 * The runs each workflow of the Apps `apps` started in the window ending
 * `until`, and their improvement signals' highest value of each kind, by
 * `keyOf` and kind, as the platform's statistics count them (`statistics`,
 * the stub of the page's permission on them): a few reads, each for up to
 * `appsPerRead` Apps, grouped by App. The Apps whose runs couldn't be read
 * are `unavailable`, never counted as none: each the caller may not see,
 * or that is gone, and every App without the permission, or of a read
 * refused as expected (another release's, say). The signals of every
 * page come from one computation, the latest finished by `until`: should
 * pages differ (a new computation cleaned it up meanwhile), they are read
 * again from the first page once, and then the snapshot is refused
 * (`board.figures_incomplete`), as it is for more groups than it reads.
 * Any other failure fails it too.
 */
const observed = async (
  statistics: Statistics | undefined,
  caller: Caller,
  apps: readonly string[],
  until: string
): Promise<{
  runs: Map<string, number>;
  signals: Map<string, Map<string, number>>;
  unavailable: Set<string>;
}> => {
  const runs = new Map<string, number>();
  const signals = new Map<string, Map<string, number>>();
  if (statistics === undefined) {
    return { runs, signals, unavailable: new Set(apps) };
  }
  const chunks = chunksOf(apps, appsPerRead);
  const started = await readChunks(statistics, caller, chunks, {
    measure: "platform.workflow_runs",
    days: windowDays,
    until,
    groupBy: ["app", "workflow"],
  });
  const readSignals = async () =>
    await readChunks(statistics, caller, chunks, {
      measure: "platform.improvement_signals",
      days: windowDays,
      until,
      groupBy: ["app", "workflow", "kind"],
    });
  let signalled = await readSignals();
  if (signalled.computations.size > 1) {
    signalled = await readSignals();
    if (signalled.computations.size > 1) {
      throw incomplete(
        "The improvement signals changed twice while they were read"
      );
    }
  }
  for (const { dimensions, count } of started.groups) {
    runs.set(keyOf(dimensions.app ?? "", dimensions.workflow ?? ""), count);
  }
  for (const { dimensions, max } of signalled.groups) {
    const key = keyOf(dimensions.app ?? "", dimensions.workflow ?? "");
    const kinds = signals.get(key) ?? new Map<string, number>();
    kinds.set(dimensions.kind ?? "", max);
    signals.set(key, kinds);
  }
  return {
    runs,
    signals,
    unavailable: new Set([...started.unavailable, ...signalled.unavailable]),
  };
};

/**
 * What a snapshot freezes of `record`: its title, its team's title (by
 * `teams`), its hours drawn (`drawn`), designed, and as it runs, by the
 * runs its App workflow started in the window (`runs`); or, when that
 * App's runs couldn't be read (`unavailable`), that they are unavailable,
 * never none.
 */
const figuresOf = (
  record: Current,
  drawn: Version | undefined,
  teams: ReadonlyMap<string, string>,
  runs: ReadonlyMap<string, number>,
  unavailable: ReadonlySet<string>
): Record<string, unknown> => {
  const { workflow, version } = record;
  const teamTitle =
    workflow.team === undefined ? undefined : teams.get(workflow.team);
  const { app } = workflow;
  const started =
    app === undefined ? 0 : (runs.get(keyOf(app.appId, app.workflowId)) ?? 0);
  const weeks = windowDays / daysPerWeek;
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
    ...(app !== undefined && unavailable.has(app.appId)
      ? { unavailable: true }
      : {}),
    ...(app === undefined || started === 0 || unavailable.has(app.appId)
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

/** What a snapshot freezes: the versions, and the figures. */
export interface Frozen {
  workflows: { path: string; version: number }[];
  figures: {
    windowDays: number;
    workflows: Record<string, unknown>[];
    signals: { path: string; kind: string; value: number }[];
  };
}

/**
 * What a snapshot taken now freezes: every workflow record in the
 * Playbook, at its current version and a designed one's latest drawn
 * version, with their hours; for a designed one linked to an App workflow
 * with runs in the window, its hours as it runs; and the improvement
 * signals of the linked App workflows, each kind's highest, in the
 * platform's order of kinds, highest first. A workflow whose record can't
 * be read is left out.
 */
export const freeze = async (
  playbook: Playbook,
  statistics: Statistics | undefined,
  caller: Caller
): Promise<Frozen> => {
  const [workflowRecords, teamRecords] = await Promise.all([
    recordsOf(playbook, caller, "workflow"),
    recordsOf(playbook, caller, "team"),
  ]);
  if (workflowRecords.length > maxFigures) {
    throw Object.assign(
      new Error(
        `A snapshot holds at most ${maxFigures} workflows, and the Playbook has ${workflowRecords.length}.`
      ),
      { code: "board.too_many_workflows" }
    );
  }
  const current = workflowRecords.flatMap((listed): Current[] => {
    const workflow = workflowOf(listed.record);
    return workflow === undefined
      ? []
      : [
          {
            id: listed.id,
            path: listed.path,
            title: listed.title,
            version: listed.currentVersion,
            workflow,
          },
        ];
  });
  const teams = new Map(teamRecords.map(({ path, title }) => [path, title]));
  const linked = new Map<string, string>();
  for (const { path, workflow } of current) {
    const { app } = workflow;
    const key =
      app === undefined ? undefined : keyOf(app.appId, app.workflowId);
    if (key !== undefined && !linked.has(key)) {
      linked.set(key, path);
    }
  }
  const apps = [
    ...new Set(
      current.flatMap(({ workflow }) =>
        workflow.app === undefined ? [] : [workflow.app.appId]
      )
    ),
  ];
  // The window ends as the snapshot is taken, for every read of it.
  const until = new Date().toISOString();
  const { runs, signals, unavailable } = await observed(
    statistics,
    caller,
    apps,
    until
  );
  const frozen: Frozen["workflows"] = [];
  const workflows: Record<string, unknown>[] = [];
  for (const record of current) {
    const drawn =
      record.workflow.state === "designed"
        ? // oxlint-disable-next-line no-await-in-loop -- one read for each designed workflow
          await drawnVersion(playbook, caller, record)
        : { version: record.version, workflow: record.workflow };
    if (drawn !== undefined) {
      frozen.push({ path: record.path, version: drawn.version });
    }
    if (record.workflow.state === "designed") {
      frozen.push({ path: record.path, version: record.version });
    }
    workflows.push(figuresOf(record, drawn, teams, runs, unavailable));
  }
  const rank = (kind: string): number => {
    const at = kindOrder.indexOf(kind);
    return at === -1 ? kindOrder.length : at;
  };
  const frozenSignals = [...linked].flatMap(([key, path]) =>
    [...(signals.get(key) ?? [])].map(([kind, value]) => ({
      path,
      kind,
      value,
    }))
  );
  return {
    workflows: frozen,
    figures: {
      windowDays,
      workflows,
      signals: frozenSignals
        .toSorted(
          (a, b) =>
            rank(a.kind) - rank(b.kind) ||
            b.value - a.value ||
            a.path.localeCompare(b.path)
        )
        .slice(0, maxSignals),
    },
  };
};
