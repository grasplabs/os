import { DurableObject } from "cloudflare:workers";

import { draftOf, refuse } from "./draft.ts";
import type { Draft } from "./draft.ts";
import { interviewSkill, notesOf, sourceOf } from "./guests.ts";
import type { GuestChat, Guests } from "./guests.ts";

// The intake's server: drafts of a source and the statements taken from
// it, kept here while someone reviews and edits them, and saved to the
// Playbook only when they say so, as one `source` record and a
// `statement` record for each claim (their types are the intake's own,
// app/records.json, which the Playbook checks every save against). The
// Playbook is written through the App's permission (`PLAYBOOK`, which an
// admin approves) and only for someone who may change it: only admins.
// Intake is theirs, so every method but `overview` refuses anyone else
// (`knowledge.forbidden`), and `overview` shows them nothing. Drafts are
// typed in by hand, or proposed by a run of the `extract` workflow, which
// takes the statements out of someone's notes, or out of a stakeholder's
// chat (app/guests.ts).

/**
 * Whoever the method runs for, as the platform passes it: with its step's
 * idempotency key when a workflow run's side-effect step calls.
 */
interface Caller {
  userId: string;
  idempotencyKey?: string;
}

/** A document, without its text. */
interface Summary {
  id: string;
  path: string;
  title: string;
  type: string;
  currentVersion: number;
}

/** The Playbook, as the App's permission gives it. */
interface Playbook {
  canWrite: (caller: Caller) => Promise<boolean>;
  ownedTypes: (caller: Caller) => Promise<string[]>;
  listDocuments: (
    caller: Caller,
    options?: { after?: string; limit?: number }
  ) => Promise<{ documents: { id: string; path: string }[] }>;
  getRecord: (
    caller: Caller,
    documentId: string
  ) => Promise<{ record: Record<string, unknown> }>;
  saveRecord: (caller: Caller, input: unknown) => Promise<Summary>;
}

/** The types a save writes: it must own both, to set their kept fields. */
const savedTypes = ["source", "statement"] as const;

interface Env {
  PLAYBOOK?: Playbook;
  GUESTS?: Guests;
}

/** Why a call was refused, by its code, or what it answered. */
type Outcome<T> = { ok: T } | { error: string };

/**
 * Where a draft came from: typed in by hand, or taken out by a model
 * (`extract`) of notes, or of a stakeholder's chat, whose words are
 * untrusted. Kept with it, so the review says what it reviews, and a
 * guest's source is saved marked as theirs.
 */
type Origin = "manual" | "notes" | "guest";

/**
 * A draft being reviewed (`open`), or being saved (`saving`): once a save
 * has started, what it saves no longer changes, so a save that stopped
 * halfway is finished with the same records, never with others.
 */
type Status = "open" | "saving";

/** A draft as the review lists it. */
interface DraftSummary {
  id: string;
  version: number;
  origin: Origin;
  status: Status;
  title: string;
  date: string;
  statements: number;
  createdBy: string;
  /** ISO 8601. */
  createdAt: string;
}

/** A draft as the review opens it. */
interface OpenedDraft extends DraftSummary {
  draft: Draft;
}

/** The most drafts the review lists: the newest. */
const draftsListed = 100;

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

/** A path segment from a name: `Anna, controller` is `anna-controller`. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 60) || "untitled";

/**
 * Where a save's records go: paths of its own, by the random key the save
 * took when it started (`save_key`), which nobody can know beforehand; a
 * save that stopped halfway and runs again writes the same ones.
 */
const pathsOf = (saveKey: string, draft: Draft) => {
  const stem = `${draft.source.date}-${slugOf(draft.source.title)}-${saveKey}`;
  return {
    source: `sources/${stem}.md`,
    statement: (position: number) => `statements/${stem}-${position}.md`,
  };
};

/**
 * Saves a new record at `path` for draft `draft`, or finds it saved by an
 * earlier attempt of the same save: a record there counts as written only
 * when it names that draft (`draft`, a field only this App's `save`
 * sets). Anything else there refuses the save (`intake.path_taken`),
 * never taken as its own.
 */
const saveNew = async (
  playbook: Playbook,
  caller: Caller,
  draft: string,
  input: { path: string; record: Record<string, unknown>; body: string }
): Promise<void> => {
  try {
    await playbook.saveRecord(caller, {
      ...input,
      record: { ...input.record, draft },
      ifVersion: 0,
    });
  } catch (error) {
    if (codeOf(error) !== "knowledge.conflict") {
      throw error;
    }
    // The document at the path: the first listed from just before it.
    const { documents } = await playbook.listDocuments(caller, {
      after: input.path.slice(0, -1),
      limit: 1,
    });
    const [there] = documents;
    const found =
      there?.path === input.path
        ? await playbook.getRecord(caller, there.id)
        : undefined;
    if (found?.record.draft !== draft) {
      refuse(
        "intake.path_taken",
        `Something else is at ${input.path}: the draft wasn't saved over it.`
      );
    }
  }
};

/** A row of the drafts table. */
interface Row {
  id: string;
  origin: Origin;
  status: Status;
  version: number;
  draft: string;
  created_by: string;
  created_at: number;
  /** The key of the save under way, which names its paths; while open, none. */
  save_key: string | null;
  [column: string]: SqlStorageValue;
}

const summaryOf = (row: Row, draft: Draft): DraftSummary => ({
  id: row.id,
  version: row.version,
  origin: row.origin,
  status: row.status,
  title: draft.source.title,
  date: draft.source.date,
  statements: draft.statements.length,
  createdBy: row.created_by,
  createdAt: new Date(row.created_at).toISOString(),
});

/** A draft as stored: checked when it was kept. */
const storedDraft = (row: Row): Draft =>
  // SAFETY: only `draftOf`'s output is ever stored (`#insert`, `#update`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  JSON.parse(row.draft) as Draft;

/** The body of a statement: its source, linked, and its quote. */
const statementBody = (sourcePath: string, quote: string): string => {
  const from = `From [[${sourcePath}]].`;
  if (quote === "") {
    return `${from}\n`;
  }
  const quoted = quote
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${from}\n\n${quoted}\n`;
};

export class App extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      version INTEGER NOT NULL,
      draft TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      save_key TEXT
    )`);
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS drafts_by_created ON drafts (created_at)"
    );
    // The draft each run's step proposed, by the step's idempotency key: a
    // step that runs again proposes nothing new.
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS proposals (
      key TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL
    )`);
  }

  /**
   * The drafts waiting for review, newest first (the latest 100), for
   * someone who may change the Playbook (`writable`); none for anyone
   * else. `access: "none"` until an admin approves the App's Playbook
   * permission. What was saved is in the Playbook, where Knowledge shows
   * it.
   */
  async overview(caller: Caller): Promise<
    Outcome<{
      access: "none" | "ok";
      writable: boolean;
      drafts: DraftSummary[];
      /** Stakeholder chats; null while the App can't invite anyone. */
      guests: GuestChat[] | null;
    }>
  > {
    const playbook = this.env.PLAYBOOK;
    if (!playbook) {
      return {
        ok: { access: "none", writable: false, drafts: [], guests: null },
      };
    }
    return await outcome(async () => {
      if (!(await playbook.canWrite(caller))) {
        return {
          access: "ok" as const,
          writable: false,
          drafts: [],
          guests: null,
        };
      }
      const drafts = this.ctx.storage.sql
        .exec<Row>(
          "SELECT * FROM drafts ORDER BY created_at DESC, id LIMIT ?",
          draftsListed
        )
        .toArray()
        .map((row) => summaryOf(row, storedDraft(row)));
      // Only a hint: without the permission, or while guest chats are off,
      // the intake offers no chats and still lists its drafts.
      const guests =
        (await this.env.GUESTS?.list(caller).catch(() => null)) ?? null;
      return { access: "ok" as const, writable: true, drafts, guests };
    });
  }

  /**
   * Invites a stakeholder, by name, to a chat about their work for `days`
   * (7 unless said): the answer holds its link, shown once.
   */
  async invite(
    caller: Caller,
    input: { name: string; days?: number }
  ): Promise<Outcome<GuestChat & { link: string }>> {
    return await outcome(async () => {
      await this.#requireWriter(caller);
      return await this.#guests().invite(caller, {
        name: input.name,
        skill: interviewSkill,
        ...(input.days === undefined ? {} : { days: input.days }),
      });
    });
  }

  /** Stops a stakeholder chat's link. */
  async revokeChat(caller: Caller, id: string): Promise<Outcome<GuestChat>> {
    return await outcome(async () => {
      await this.#requireWriter(caller);
      return await this.#guests().revoke(caller, id);
    });
  }

  /**
   * A stakeholder chat as notes to read, and the source it is: for the
   * `extract` workflow. One nobody wrote in yet is refused
   * (`intake.empty_chat`).
   */
  async chatNotes(
    caller: Caller,
    id: string
  ): Promise<Outcome<{ source: ReturnType<typeof sourceOf>; notes: string }>> {
    return await outcome(async () => {
      await this.#requireWriter(caller);
      const chat = await this.#guests().read(caller, id);
      if (!chat.messages.some(({ role }) => role === "guest")) {
        refuse("intake.empty_chat", "Nobody wrote in this chat yet.");
      }
      return { source: sourceOf(chat), notes: notesOf(chat) };
    });
  }

  /** A draft, to review. */
  async draft(caller: Caller, id: string): Promise<Outcome<OpenedDraft>> {
    return await outcome(async () => {
      await this.#requireWriter(caller);
      const row = this.#row(id);
      const draft = storedDraft(row);
      return { ...summaryOf(row, draft), draft };
    });
  }

  /** Starts a draft by hand, with what the screen typed. */
  async create(
    caller: Caller,
    input: unknown
  ): Promise<Outcome<{ id: string; version: number }>> {
    return await outcome(async () => {
      await this.#requireWriter(caller);
      const id = crypto.randomUUID();
      this.#insert(id, "manual", draftOf(input), caller);
      return { id, version: 1 };
    });
  }

  /**
   * Keeps a draft a run of `extract` proposes, for its starter to review:
   * only from a workflow run's side-effect step, by its idempotency key,
   * once, so a step that runs again answers the draft it kept the first
   * time. Refused (`intake.invalid`) from anywhere else, such as a screen.
   */
  async propose(
    caller: Caller,
    input: unknown
  ): Promise<Outcome<{ id: string }>> {
    return await outcome(async () => {
      await this.#requireWriter(caller);
      const key =
        caller.idempotencyKey ??
        refuse("intake.invalid", "Only a workflow run proposes a draft.");
      const draft = draftOf(input);
      // Taken out of a stakeholder's chat (`chatNotes`): their words.
      const fromGuest =
        typeof input === "object" &&
        input !== null &&
        "guest" in input &&
        input.guest === true;
      const [known] = this.ctx.storage.sql
        .exec<{ draft_id: string }>(
          "SELECT draft_id FROM proposals WHERE key = ?",
          key
        )
        .toArray();
      if (known !== undefined) {
        return { id: known.draft_id };
      }
      const id = crypto.randomUUID();
      this.#insert(id, fromGuest ? "guest" : "notes", draft, caller);
      this.ctx.storage.sql.exec(
        "INSERT INTO proposals (key, draft_id) VALUES (?, ?)",
        key,
        id
      );
      return { id };
    });
  }

  /**
   * Keeps the edits of a draft at `ifVersion`, as its next version, not
   * saving it to the Playbook yet. Refused with `intake.conflict` when
   * someone kept or saved it since.
   */
  async keep(
    caller: Caller,
    input: { id: string; ifVersion: number; draft: unknown }
  ): Promise<Outcome<{ version: number }>> {
    return await outcome(async () => {
      await this.#requireWriter(caller);
      const draft = draftOf(input.draft);
      const version = this.#next(input.id, input.ifVersion, "open", draft);
      return { version };
    });
  }

  /**
   * Throws a draft away, at `ifVersion`: an open one, or one whose save
   * stopped halfway, or is still under way (`saving`), which then stops
   * before its next write. Records it already wrote stay in the Playbook,
   * where Knowledge shows them; one write on its way as it is discarded
   * may still land. Answers whether a save had started (`saving`), so the
   * screen can say so.
   */
  async discard(
    caller: Caller,
    input: { id: string; ifVersion: number }
  ): Promise<Outcome<{ saving: boolean }>> {
    return await outcome(async () => {
      await this.#requireWriter(caller);
      const row = this.#row(input.id);
      if (row.version !== input.ifVersion) {
        refuse("intake.conflict", "The draft changed since it was opened.");
      }
      this.ctx.storage.sql.exec("DELETE FROM drafts WHERE id = ?", input.id);
      return { saving: row.status === "saving" };
    });
  }

  /**
   * Saves a draft to the Playbook, as it was edited (`draft`), at
   * `ifVersion`: its source, then each statement naming it, then drops
   * the draft. A draft must have a statement. Refused before anything is
   * written (`intake.not_owner`) unless this App owns the Playbook's
   * `source` and `statement` types, whose kept fields only their owner's
   * `save` sets. Once a save has started, the draft is `saving`: its
   * edits, and the paths it writes (by a random key), are fixed, and
   * saving it again finishes it with what the first save started
   * (whatever `draft` says), writing only the records not in the Playbook
   * yet. A record already at one of its paths counts as written only when
   * it names this draft; anything else refuses the save
   * (`intake.path_taken`). A `saving` draft that can't finish can be
   * discarded.
   */
  async save(
    caller: Caller,
    input: { id: string; ifVersion: number; draft: unknown }
  ): Promise<Outcome<{ source: string; statements: number }>> {
    return await outcome(async () => {
      const playbook = await this.#requireWriter(caller);
      // Only the owner of both types sets their kept fields: another copy
      // of the intake would write the source and then be refused at the
      // first statement. Checked before anything is written.
      const owned = await playbook.ownedTypes(caller);
      if (!savedTypes.every((type) => owned.includes(type))) {
        refuse(
          "intake.not_owner",
          "Another copy of the intake keeps the Playbook's sources and statements."
        );
      }
      const row = this.#row(input.id);
      let draft = storedDraft(row);
      let saveKey = row.save_key;
      if (row.status === "open") {
        draft = draftOf(input.draft);
        if (draft.statements.length === 0) {
          refuse("intake.no_statements", "Add a statement to save.");
        }
        // Before the first write, and before anything else can run here:
        // from now on, what this saves, and where, is fixed.
        saveKey = crypto.randomUUID();
        this.#next(input.id, input.ifVersion, "saving", draft, saveKey);
      }
      const key =
        saveKey ?? refuse("intake.conflict", "The draft's save has no key.");
      const paths = pathsOf(key, draft);
      // Before each write: the draft is still here, saving under this key.
      // One discarded meanwhile (from another tab, say) stops the save.
      const stillSaving = () => {
        const [now] = this.ctx.storage.sql
          .exec<Row>("SELECT * FROM drafts WHERE id = ?", input.id)
          .toArray();
        if (now?.status !== "saving" || now.save_key !== key) {
          refuse(
            "intake.discarded",
            "The draft was discarded while it was saved: records already written stay in the Playbook."
          );
        }
      };
      const { source, statements } = draft;
      stillSaving();
      await saveNew(playbook, caller, input.id, {
        path: paths.source,
        record: {
          type: "source",
          title: source.title,
          medium: source.medium,
          date: source.date,
          ...(source.from === "" ? {} : { from: source.from }),
          ...(row.origin === "guest" ? { guest: true } : {}),
        },
        body: source.notes === "" ? "" : `${source.notes}\n`,
      });
      for (const [index, statement] of statements.entries()) {
        stillSaving();
        // oxlint-disable-next-line no-await-in-loop -- each after its source, in order
        await saveNew(playbook, caller, input.id, {
          path: paths.statement(index + 1),
          record: {
            type: "statement",
            title: statement.text,
            source: paths.source,
            date: source.date,
            tags: statement.tags,
          },
          body: statementBody(paths.source, statement.quote),
        });
      }
      this.ctx.storage.sql.exec("DELETE FROM drafts WHERE id = ?", input.id);
      return { source: paths.source, statements: statements.length };
    });
  }

  /** The Playbook, for someone who may change it; refused otherwise. */
  async #requireWriter(caller: Caller): Promise<Playbook> {
    const playbook = this.env.PLAYBOOK;
    if (!playbook) {
      return refuse("permission.denied", "The App has no Playbook permission.");
    }
    if (!(await playbook.canWrite(caller))) {
      refuse("knowledge.forbidden", "Only admins take intake.");
    }
    return playbook;
  }

  /** Stores a new draft, open for review at version 1. */
  #insert(id: string, origin: Origin, draft: Draft, caller: Caller): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO drafts (id, origin, status, version, draft, created_by, created_at) VALUES (?, ?, 'open', 1, ?, ?, ?)",
      id,
      origin,
      JSON.stringify(draft),
      caller.userId,
      Date.now()
    );
  }

  /** Guest chats, as the App's permission gives them. */
  #guests(): Guests {
    return (
      this.env.GUESTS ??
      refuse("permission.denied", "The App has no permission to invite guests.")
    );
  }

  /** The draft `id`; `intake.not_found` when there is none. */
  #row(id: string): Row {
    const [row] = this.ctx.storage.sql
      .exec<Row>("SELECT * FROM drafts WHERE id = ?", id)
      .toArray();
    return row ?? refuse("intake.not_found", "There's no such draft.");
  }

  /**
   * Stores `draft` as the next version of an open draft at `ifVersion`,
   * now `status`; `intake.conflict` when it is at another, or saving.
   */
  #next(
    id: string,
    ifVersion: number,
    status: Status,
    draft: Draft,
    saveKey: string | null = null
  ): number {
    const row = this.#row(id);
    if (row.status !== "open" || row.version !== ifVersion) {
      refuse("intake.conflict", "The draft changed since it was opened.");
    }
    this.ctx.storage.sql.exec(
      "UPDATE drafts SET status = ?, version = ?, draft = ?, save_key = ? WHERE id = ?",
      status,
      ifVersion + 1,
      JSON.stringify(draft),
      saveKey,
      id
    );
    return ifVersion + 1;
  }
}
