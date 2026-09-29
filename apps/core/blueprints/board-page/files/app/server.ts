import { DurableObject } from "cloudflare:workers";

import { freeze } from "./figures.ts";
import type {
  Caller,
  Playbook,
  RecordRead,
  Statistics,
  Summary,
} from "./figures.ts";

// The board page's server: it lists the Playbook's snapshots, reads one,
// takes a new one and saves its narrative and the decision it asks for,
// for the person using the page, through the App's Playbook permission
// (`PLAYBOOK`, which an admin approves). `take` works out what a snapshot
// freezes (figures.ts) and is the one method that sets it
// (`app/records.json`): saving it again, by this page, a person or the
// agent, keeps it. Only admins change the Playbook; everyone else who can
// open the page reads it.

interface Env {
  PLAYBOOK?: Playbook;
  /** The page's permission on the platform's statistics, once granted. */
  PLATFORM?: Statistics;
}

/** A snapshot as the page lists it. */
interface Listed {
  id: string;
  path: string;
  title: string;
}

/** A snapshot as the page shows it. */
interface Snapshot {
  id: string;
  path: string;
  version: number;
  record: Record<string, unknown>;
  body: string;
}

/** Why a read or write was refused, by its code, or what it answered. */
type Outcome<T> = { ok: T } | { error: string };

/** The most documents one page of the Playbook lists. */
const pageSize = 200;

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

/**
 * A page of the Playbook's documents, after the path `after`; none while
 * the Playbook doesn't exist yet.
 */
const pageOf = async (
  playbook: Playbook,
  caller: Caller,
  after: string | undefined
): Promise<Summary[]> => {
  try {
    const { documents } = await playbook.listDocuments(caller, {
      ...(after === undefined ? {} : { after }),
      limit: pageSize,
    });
    return documents;
  } catch (error) {
    if (codeOf(error) === "knowledge.not_found") {
      return [];
    }
    throw error;
  }
};

/** Every document in the Playbook, a page at a time. */
const documentsOf = async (
  playbook: Playbook,
  caller: Caller
): Promise<Summary[]> => {
  const all: Summary[] = [];
  let after: string | undefined;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- each page starts after the last
    const page = await pageOf(playbook, caller, after);
    all.push(...page);
    if (page.length < pageSize) {
      return all;
    }
    after = page.at(-1)?.path;
  }
};

const snapshotOf = (read: RecordRead): Snapshot => ({
  id: read.id,
  path: read.path,
  version: read.version.number,
  record: read.record,
  body: read.body,
});

export class App extends DurableObject<Env> {
  /**
   * The Playbook's snapshots, by path, last first: `take` puts each under
   * `snapshots/`, by its date, so the newest it took comes first.
   * `access: "none"` until an admin approves the App's Playbook
   * permission.
   */
  async snapshots(
    caller: Caller
  ): Promise<Outcome<{ access: "none" | "ok"; snapshots: Listed[] }>> {
    const playbook = this.env.PLAYBOOK;
    if (!playbook) {
      return { ok: { access: "none", snapshots: [] } };
    }
    return await outcome(async () => {
      const documents = await documentsOf(playbook, caller);
      const snapshots = documents
        .filter(({ type }) => type === "snapshot")
        .map(({ id, path, title }) => ({ id, path, title }))
        .toSorted((a, b) => b.path.localeCompare(a.path));
      return { access: "ok" as const, snapshots };
    });
  }

  /**
   * A snapshot, at its current version; refused with `board.not_snapshot`
   * for any other document.
   */
  async open(caller: Caller, id: string): Promise<Outcome<Snapshot>> {
    return await outcome(async () =>
      snapshotOf(await this.#snapshot(caller, id))
    );
  }

  /**
   * Takes a snapshot of the Playbook now, with the maturity it records
   * (0 to 5, which the snapshot's type checks), and the decision it asks
   * for: a new record, under `snapshots/` by the time it was taken, so
   * paths sort as snapshots were taken, that freezes every workflow
   * record's hours and the signals of the App workflows they link to.
   */
  async take(
    caller: Caller,
    input: { maturity: number; decisionNeeded?: string }
  ): Promise<Outcome<Summary>> {
    return await outcome(async () => {
      const playbook = this.#playbook();
      // Whoever may not change the Playbook is refused by the save.
      const { workflows, figures } = await freeze(
        playbook,
        this.env.PLATFORM,
        caller
      );
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      // Its own path each time (`2026-09-28T101530123Z`, after an older
      // path of that day); two taken at once are two snapshots.
      const taken = `${date}T${now.toISOString().slice(11, 23).replaceAll(/[:.]/gu, "")}Z`;
      const decisionNeeded = input.decisionNeeded?.trim() ?? "";
      return await playbook.saveRecord(caller, {
        path: `snapshots/${taken}-${crypto.randomUUID().slice(0, 8)}.md`,
        ifVersion: 0,
        record: {
          type: "snapshot",
          title: `Snapshot ${date}`,
          date,
          maturity: input.maturity,
          workflows,
          figures,
          ...(decisionNeeded === "" ? {} : { decisionNeeded }),
        },
        body: "",
        message: "Taken",
      });
    });
  }

  /**
   * Saves a snapshot's narrative and the decision it asks for as its next
   * version (`ifVersion`): what it froze stays as it was taken. Refused
   * with `board.not_snapshot` for a document that isn't a snapshot, and
   * with `knowledge.conflict` when someone saved it meanwhile.
   */
  async write(
    caller: Caller,
    input: {
      id: string;
      ifVersion: number;
      decisionNeeded: string;
      body: string;
    }
  ): Promise<Outcome<Summary>> {
    return await outcome(async () => {
      const playbook = this.#playbook();
      // Only a snapshot's narrative: never another record it was handed.
      const current = await this.#snapshot(caller, input.id);
      // The Playbook keeps what it froze, which only `take` sets.
      const {
        figures: _figures,
        decisionNeeded: _decision,
        ...kept
      } = current.record;
      const decisionNeeded = input.decisionNeeded.trim();
      return await playbook.saveRecord(caller, {
        path: current.path,
        ifVersion: input.ifVersion,
        // Saved as a snapshot, which the Playbook checks it against.
        record: {
          ...kept,
          type: "snapshot",
          ...(decisionNeeded === "" ? {} : { decisionNeeded }),
        },
        body: input.body,
        message: "Narrative",
      });
    });
  }

  /** The document `id`, refused unless it is a snapshot. */
  async #snapshot(caller: Caller, id: string): Promise<RecordRead> {
    const read = await this.#playbook().getRecord(caller, id);
    if (read.type !== "snapshot") {
      throw Object.assign(new Error("That document isn't a snapshot."), {
        code: "board.not_snapshot",
      });
    }
    return read;
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
