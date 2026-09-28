import { DurableObject } from "cloudflare:workers";

// The workflow map's server: it reads and writes the Playbook's workflow
// and team records for the person using the map, through the App's
// Playbook permission (`PLAYBOOK`, which an admin approves). Only admins
// change the Playbook; everyone else who can open the map reads it, and
// the Playbook says which the caller is (`canWrite`). It keeps nothing of
// its own: the Playbook is where the records live, with their versions.

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
  linkWorkflow: (caller: Caller, input: unknown) => Promise<Summary>;
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

/** The most versions of a workflow the map looks back for its drawn one. */
const historyDepth = 50;

const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : "app.failed";

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
   * drawn, to set beside it.
   */
  async open(
    caller: Caller,
    id: string
  ): Promise<Outcome<{ current: Workflow; drawn: Workflow | null }>> {
    return await outcome(async () => {
      const playbook = this.#playbook();
      const current = workflowOf(await playbook.getRecord(caller, id));
      if (current.record.state !== "designed") {
        return { current, drawn: null };
      }
      const { versions } = await playbook.history(caller, id, {
        before: current.version,
        limit: historyDepth,
      });
      for (const { number } of versions) {
        // oxlint-disable-next-line no-await-in-loop -- newest first, until the drawn one
        const earlier = await playbook.getRecord(caller, id, number);
        if (earlier.record.state === "drawn") {
          return { current, drawn: workflowOf(earlier) };
        }
      }
      return { current, drawn: null };
    });
  }

  /**
   * Saves a workflow's record as its next version (`ifVersion`, 0 for a
   * new one at a path of its own). Refused with `knowledge.conflict` when
   * someone saved it meanwhile.
   */
  async save(
    caller: Caller,
    input: {
      path?: string;
      ifVersion: number;
      record: Record<string, unknown>;
      body: string;
      message?: string;
    }
  ): Promise<Outcome<Summary>> {
    return await outcome(async () => {
      const title =
        typeof input.record.title === "string" ? input.record.title : "";
      const path =
        input.path ??
        `workflows/${slugOf(title)}-${crypto.randomUUID().slice(0, 8)}.md`;
      return await this.#playbook().saveRecord(caller, { ...input, path });
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

  /** Links a designed workflow to the App workflow built from it. */
  async link(
    caller: Caller,
    input: {
      documentId: string;
      ifVersion: number;
      appId: string;
      workflowId: string;
    }
  ): Promise<Outcome<Summary>> {
    return await outcome(
      async () => await this.#playbook().linkWorkflow(caller, input)
    );
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
