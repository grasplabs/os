import { DurableObject } from "cloudflare:workers";

// The workflow map's server: it reads and writes the Playbook's workflow
// and team records for the person using the map, through the App's
// Playbook permission (`PLAYBOOK`, which an admin approves). Only admins
// change the Playbook; everyone else who can open the map reads it, and
// the Playbook says which the caller is (`canWrite`). It keeps nothing of
// its own: the Playbook is where the records live, with their versions.
// Their types are the map's own (`app/records.json`), which the Playbook
// checks every save against, whoever saves; a workflow's link to the App
// workflow that runs it is set only by `link`, and kept by every other
// save.

/** Whoever the method runs for, as the platform passes it. */
interface Caller {
  userId: string;
}

/** A document, without its text. */
interface Summary {
  id: string;
  path: string;
  title: string;
  type: string;
  currentVersion: number;
}

/** A record at its current version, as a page of records lists it. */
interface RecordSummary extends Summary {
  record: Record<string, unknown>;
  body: string;
}

/** A document read as a record: its frontmatter as data, and its Markdown. */
interface RecordRead extends RecordSummary {
  version: { number: number };
}

/** The Playbook, as the App's permission gives it. */
interface Playbook {
  listRecords: (
    caller: Caller,
    options?: { after?: string; limit?: number; type?: string }
  ) => Promise<{
    records: RecordSummary[];
    unreadable: Summary[];
    next: string | null;
  }>;
  canWrite: (caller: Caller) => Promise<boolean>;
  getRecord: (
    caller: Caller,
    documentId: string,
    version?: number
  ) => Promise<RecordRead>;
  history: (
    caller: Caller,
    documentId: string,
    options?: { before?: number; limit?: number }
  ) => Promise<{ versions: { number: number }[] }>;
  saveRecord: (caller: Caller, input: unknown) => Promise<Summary>;
}

interface Env {
  PLAYBOOK?: Playbook;
}

/** A workflow as the map lists and edits it. */
interface Workflow {
  id: string;
  path: string;
  version: number;
  record: Record<string, unknown>;
  body: string;
}

/** A team the map groups workflows by. */
interface Team {
  path: string;
  title: string;
}

/** Why a read or write was refused, by its code, or what it answered. */
type Outcome<T> = { ok: T } | { error: string };

/** The most records one page of the Playbook lists. */
const pageSize = 20;

const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : "app.failed";

/** Refuses a call with `code`, which the screen explains. */
const refuse = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};

/** Refuses a document the map reads or writes as a workflow when it isn't one. */
const requireWorkflow = (read: RecordRead): void => {
  if (read.record.type !== "workflow") {
    refuse("map.not_workflow", `${read.path} isn't a workflow.`);
  }
};

const outcome = async <T>(run: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: codeOf(error) };
  }
};

const workflowOf = (read: RecordRead): Workflow => ({
  id: read.id,
  path: read.path,
  version: read.version.number,
  record: read.record,
  body: read.body,
});

/** A record of a page, as the map lists it: at its current version. */
const listedOf = (listed: RecordSummary): Workflow => ({
  id: listed.id,
  path: listed.path,
  version: listed.currentVersion,
  record: listed.record,
  body: listed.body,
});

/** The records of `type` in the Playbook, and those that can't be read. */
interface Records {
  records: RecordSummary[];
  unreadable: Summary[];
}

/**
 * Every record of `type` in the Playbook, a page (one read) at a time;
 * none while the Playbook doesn't exist yet.
 */
const recordsOf = async (
  playbook: Playbook,
  caller: Caller,
  type: string
): Promise<Records> => {
  const all: Records = { records: [], unreadable: [] };
  let after: string | undefined;
  for (;;) {
    let page: Records & { next: string | null };
    try {
      // oxlint-disable-next-line no-await-in-loop -- each page starts after the last
      page = await playbook.listRecords(caller, {
        ...(after === undefined ? {} : { after }),
        limit: pageSize,
        type,
      });
    } catch (error) {
      if (codeOf(error) === "knowledge.not_found") {
        return all;
      }
      throw error;
    }
    all.records.push(...page.records);
    all.unreadable.push(...page.unreadable);
    if (page.next === null) {
      return all;
    }
    after = page.next;
  }
};

/**
 * The version of a workflow last drawn, as a save of it designed keeps
 * it: the version `stored` is, when that one is drawn; otherwise the one
 * it keeps already; none for a new one.
 */
const drawnVersionOf = (stored: RecordRead | undefined): number | undefined => {
  if (stored === undefined) {
    return undefined;
  }
  if (stored.record.state === "drawn") {
    return stored.version.number;
  }
  const kept = stored.record.drawnVersion;
  return typeof kept === "number" ? kept : undefined;
};

/** `value` trimmed, if it is text. */
const trim = (value: unknown): unknown =>
  typeof value === "string" ? value.trim() : value;

/** Each of `fields` of `entry` trimmed, where it is text. */
const trimFields = (entry: unknown, fields: readonly string[]): unknown => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return entry;
  }
  const fieldsOf: Record<string, unknown> = Object.fromEntries(
    Object.entries(entry)
  );
  for (const field of fields) {
    if (field in fieldsOf) {
      fieldsOf[field] = trim(fieldsOf[field]);
    }
  }
  return fieldsOf;
};

/**
 * A workflow record with its names trimmed, as the Playbook's schema of
 * it, which can't trim, holds them: its title, and its steps' and
 * parameters' texts.
 */
const trimmed = (record: Record<string, unknown>): Record<string, unknown> => ({
  ...record,
  ...(record.title === undefined ? {} : { title: trim(record.title) }),
  ...(Array.isArray(record.steps)
    ? {
        steps: record.steps.map((step) =>
          trimFields(step, ["name", "who", "tool"])
        ),
      }
    : {}),
  ...(Array.isArray(record.parameters)
    ? {
        parameters: record.parameters.map((parameter) =>
          trimFields(parameter, ["name", "value"])
        ),
      }
    : {}),
});

/** A path segment from a name: `Pay invoices` is `pay-invoices`. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 60) || "untitled";

export class App extends DurableObject<Env> {
  /**
   * Every workflow in the Playbook, with its record, every team, and
   * whether the caller may change them (`writable`). `access: "none"`
   * until an admin approves the App's Playbook permission; no workflows
   * while the Playbook has none, or doesn't exist yet (an admin's first
   * save sets it up). A workflow whose record can't be read any more
   * (saved under other schemas, say) is left out and named in
   * `unreadable`, and the others are still listed. Read a page of records
   * at a time: one read, and one audit event, for every 20.
   */
  async overview(caller: Caller): Promise<
    Outcome<{
      access: "none" | "ok";
      writable: boolean;
      workflows: Workflow[];
      unreadable: { path: string; title: string }[];
      teams: Team[];
    }>
  > {
    const playbook = this.env.PLAYBOOK;
    if (!playbook) {
      return {
        ok: {
          access: "none",
          writable: false,
          workflows: [],
          unreadable: [],
          teams: [],
        },
      };
    }
    return await outcome(async () => {
      const [workflows, teams, writable] = await Promise.all([
        recordsOf(playbook, caller, "workflow"),
        recordsOf(playbook, caller, "team"),
        // Only a hint: when it can't be had, the map is read only, and
        // still lists what it read.
        playbook.canWrite(caller).catch(() => false),
      ]);
      return {
        access: "ok" as const,
        writable,
        workflows: workflows.records.map(listedOf),
        unreadable: workflows.unreadable.map(({ path, title }) => ({
          path,
          title,
        })),
        // A team is its path and title: one whose record can't be read
        // still groups workflows.
        teams: [...teams.records, ...teams.unreadable]
          .map(({ path, title }) => ({ path, title }))
          .toSorted((a, b) => (a.path < b.path ? -1 : 1)),
      };
    });
  }

  /**
   * A workflow, and for a designed one, the last version of it that was
   * drawn (its `drawnVersion`, which `save` keeps), to set beside it; none
   * when that version no longer reads as a workflow. Any other document
   * is refused (`map.not_workflow`): the map never shows one as a
   * workflow.
   */
  async open(
    caller: Caller,
    id: string
  ): Promise<Outcome<{ current: Workflow; drawn: Workflow | null }>> {
    return await outcome(async () => {
      const playbook = this.#playbook();
      const read = await playbook.getRecord(caller, id);
      requireWorkflow(read);
      const current = workflowOf(read);
      if (current.record.state !== "designed") {
        return { current, drawn: null };
      }
      const { drawnVersion } = current.record;
      if (typeof drawnVersion !== "number") {
        return { current, drawn: null };
      }
      try {
        const earlier = await playbook.getRecord(caller, id, drawnVersion);
        return {
          current,
          drawn: earlier.record.state === "drawn" ? workflowOf(earlier) : null,
        };
      } catch (error) {
        if (codeOf(error) === "knowledge.invalid") {
          return { current, drawn: null };
        }
        throw error;
      }
    });
  }

  /**
   * Saves a workflow's record as its next version (`ifVersion`, 0 for a
   * new one at a path of its own). Refused with `knowledge.conflict` when
   * someone saved it meanwhile. It writes only workflows: a record of
   * another type, or a version of a document that isn't a workflow (named
   * by `documentId`, which a save from `ifVersion` 1 on needs, at `path`),
   * is refused with `map.not_workflow`, so the map never turns a team or
   * any other record into a workflow. A designed workflow keeps the
   * version of it last drawn (`drawnVersion`, which only this method
   * sets); a linked one stays designed (`map.linked_drawn`). Names are
   * saved trimmed.
   */
  async save(
    caller: Caller,
    input: {
      documentId?: string;
      path?: string;
      ifVersion: number;
      record: Record<string, unknown>;
      body: string;
      message?: string;
    }
  ): Promise<Outcome<Summary>> {
    return await outcome(async () => {
      const playbook = this.#playbook();
      const { documentId, ...save } = input;
      if (save.record.type !== "workflow") {
        refuse("map.not_workflow", "The map saves only workflows.");
      }
      let stored: RecordRead | undefined;
      if (save.ifVersion > 0) {
        stored =
          documentId === undefined
            ? refuse("map.not_workflow", "Name the workflow to save.")
            : await playbook.getRecord(caller, documentId);
        requireWorkflow(stored);
        if (stored.path !== save.path) {
          refuse("map.not_workflow", `${stored.path} isn't at ${save.path}.`);
        }
      }
      const { drawnVersion: _drawn, ...record } = trimmed(save.record);
      const linked =
        record.app !== undefined || stored?.record.app !== undefined;
      if (record.state === "drawn" && linked) {
        refuse(
          "map.linked_drawn",
          "A workflow linked to an App workflow stays designed."
        );
      }
      const drawnVersion =
        record.state === "designed" ? drawnVersionOf(stored) : undefined;
      const title = typeof record.title === "string" ? record.title : "";
      const path =
        save.path ??
        `workflows/${slugOf(title)}-${crypto.randomUUID().slice(0, 8)}.md`;
      return await playbook.saveRecord(caller, {
        ...save,
        record: {
          ...record,
          ...(drawnVersion === undefined ? {} : { drawnVersion }),
        },
        path,
      });
    });
  }

  /** Adds a team to group workflows by. */
  async addTeam(caller: Caller, name: string): Promise<Outcome<Team>> {
    return await outcome(async () => {
      const saved = await this.#playbook().saveRecord(caller, {
        path: `teams/${slugOf(name)}-${crypto.randomUUID().slice(0, 8)}.md`,
        ifVersion: 0,
        record: { type: "team", title: name },
        body: "",
      });
      return { path: saved.path, title: saved.title };
    });
  }

  /**
   * Links a designed workflow, at `ifVersion`, to the App workflow built
   * from it, by the App's and the workflow's IDs, as its next version: the
   * one method that sets a workflow's `app` (`app/records.json`). Refused
   * with `map.not_workflow` for another document, `map.not_designed` for a
   * drawn workflow, and `knowledge.conflict` when someone saved it since.
   */
  async link(
    caller: Caller,
    input: {
      documentId: string;
      ifVersion: number;
      appId: string;
      workflowId: string;
    }
  ): Promise<Outcome<Summary>> {
    return await outcome(async () => {
      const playbook = this.#playbook();
      const read = await playbook.getRecord(caller, input.documentId);
      requireWorkflow(read);
      if (read.record.state !== "designed") {
        refuse(
          "map.not_designed",
          "Only a designed workflow links to an App workflow."
        );
      }
      return await playbook.saveRecord(caller, {
        path: read.path,
        ifVersion: input.ifVersion,
        record: {
          ...read.record,
          app: { appId: input.appId, workflowId: input.workflowId },
        },
        body: read.body,
        message: "Linked to its App workflow",
      });
    });
  }

  #playbook(): Playbook {
    const playbook = this.env.PLAYBOOK;
    if (!playbook) {
      throw Object.assign(new Error("The App has no Playbook permission."), {
        code: "permission.denied",
      });
    }
    return playbook;
  }
}
