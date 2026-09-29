import { auditEventSchema } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { knowledgeSignalsPerKind } from "@grasp-os/shared/knowledge-signals";
import type { KnowledgeSignal } from "@grasp-os/shared/knowledge-signals";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import type { z } from "zod";

import { auditLog } from "../src/audit-log.ts";
import { refreshDailySignals } from "../src/daily-signals.ts";
import { agentKnowledgeSignals } from "../src/knowledge/signals.ts";
import { allEvents, logHead } from "./audit-events.ts";
import { runQuarterHourCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { fullScan, planOf, recordedQueries } from "./query-plans.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Knowledge usage signals, computed once a day from the audit log and the
// documents, for the owners of the collections they are about. Each test
// has collections of its own, computes the signals as of a day of its own
// (later than the last test's), and reads them as the owner, through the
// API. The last ones archive part of the log, as retention does.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;
const hourMs = 60 * 60 * 1000;

/**
 * Each computation's day: a day after the last test's, from tomorrow on,
 * at noon UTC, so a test's computations stay on their day whatever time
 * the suite runs.
 */
let days = 0;
const nextDay = (): Date => {
  days += 1;
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  return new Date(today.getTime() + days * dayMs);
};

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** An admin, who owns the collections they create for everyone. */
const newOwner = async (): Promise<Person> => await signedInApi(idp, "admin");

/** Someone who reads and searches Knowledge. */
const newReader = async (): Promise<Person> => await signedInApi(idp, "user");

/** A collection of `owner`'s for everyone; returns its ID. */
const newCollection = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.knowledge.createCollection({
    name: `Handbook ${unique()}`,
    access: "everyone",
  });
  return id;
};

/** Saves a new document; returns its ID. */
const newDocument = async (
  owner: Person,
  collectionId: string,
  path: string,
  {
    review,
    body = "How it goes here.",
  }: { review?: string; body?: string } = {}
): Promise<string> => {
  const frontmatter =
    review === undefined ? "" : `---\nreview: ${review}\n---\n`;
  const { id } = await owner.api.knowledge.saveDocument({
    collectionId,
    path,
    text: `${frontmatter}# ${path}\n\n${body}`,
    ifVersion: 0,
  });
  return id;
};

/** Marks the document last changed `ago` before `day`. */
const changedAgo = async (
  documentId: string,
  day: Date,
  ago: number
): Promise<void> => {
  await env.KNOWLEDGE.prepare(
    "UPDATE documents SET updated_at = ? WHERE id = ?"
  )
    .bind(day.getTime() - ago, documentId)
    .run();
};

/** Appends events to the deployment's log, as draining an outbox does. */
const logged = async (
  ...entries: Partial<z.input<typeof auditEventSchema>>[]
): Promise<void> => {
  const events: AuditEvent[] = entries.map((entry) =>
    auditEventSchema.parse({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      source: "core",
      actor: { type: "system" },
      action: "knowledge.search",
      ...entry,
    })
  );
  await auditLog(env).append(events);
};

/** A search in `collectionId` that found nothing, by the person `userId`. */
const emptySearch = (
  userId: string,
  queryKey: string,
  collectionId: string
) => ({
  actor: { type: "person" as const, userId },
  action: "knowledge.search.empty",
  target: { type: "collection", id: collectionId },
  detail: { terms: 2, queryKey, sensitive: false },
});

/** The signals `person` lists about `collectionId`, without their IDs. */
const signalsOf = async (person: Person, collectionId: string) => {
  const { signals } = await person.api.knowledgeSignals.list();
  return signals
    .filter(({ collection }) => collection.id === collectionId)
    .map(({ id: _id, collection: _collection, ...signal }) => signal);
};

/** The signal of `kind` `person` lists about `collectionId`. */
const signalOf = async (
  person: Person,
  collectionId: string,
  kind: KnowledgeSignal["kind"]
): Promise<KnowledgeSignal | undefined> => {
  const { signals } = await person.api.knowledgeSignals.list();
  return signals.find(
    (signal) => signal.kind === kind && signal.collection.id === collectionId
  );
};

/** Questions' values, without when each was last asked. */
const questions = (signals: Awaited<ReturnType<typeof signalsOf>>) =>
  signals.flatMap((signal) =>
    signal.kind === "unanswered_question"
      ? [
          {
            value: signal.value,
            searches: signal.evidence.searches,
            askers: signal.evidence.askers,
          },
        ]
      : []
  );

/** The audit events of `action` about `day`'s computations. */
const computationsOf = async (
  day: Date,
  action = "knowledge.signals.computed"
): Promise<AuditEvent[]> => {
  const events = await allEvents();
  return events.filter(
    (event) =>
      event.action === action &&
      event.detail.day === day.toISOString().slice(0, 10)
  );
};

/** How many computations of `day` the audit log recorded, as `action`. */
const computedOn = async (day: Date, action?: string): Promise<number> => {
  const events = await computationsOf(day, action);
  return events.length;
};

/** A claim of `day`'s computation, started `ago` before `at`, unfinished. */
const seedClaim = async (day: Date, at: Date, ago: number): Promise<void> => {
  await env.KNOWLEDGE.prepare(
    "INSERT INTO knowledge_signal_computations (id, day, started_at) VALUES (?, ?, ?)"
  )
    .bind(
      crypto.randomUUID(),
      day.toISOString().slice(0, 10),
      at.getTime() - ago
    )
    .run();
};

/**
 * Knowledge's database, running `first` once, just before the first batch
 * with a statement that starts with `statement`.
 */
const racingSignals = (
  statement: string,
  first: () => Promise<void>
): D1Database => {
  let writing = false;
  let raced = false;
  return new Proxy(env.KNOWLEDGE, {
    get: (target, property) => {
      if (property === "prepare") {
        return (query: string) => {
          writing ||= query.startsWith(statement);
          return target.prepare(query);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (writing && !raced) {
            raced = true;
            await first();
          }
          return await target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function"
        ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
        : value;
    },
  });
};

describe("Knowledge usage signals", () => {
  it("are computed once a day by the cron trigger, in one pass with the improvement signals", async () => {
    await runQuarterHourCron();
    await runQuarterHourCron();

    // The second run finds both days computed.
    const today = new Date();
    expect({
      knowledge: await computedOn(today),
      improvement: await computedOn(today, "improvement.signals.computed"),
    }).toStrictEqual({ knowledge: 1, improvement: 1 });
  });

  it("take over a day's claim once it lapsed, a few times a day at most", async () => {
    const day = nextDay();
    const spent = nextDay();
    // Claimed five minutes ago, and still running: left alone, until its
    // lease is up an hour later.
    await seedClaim(day, day, 5 * 60 * 1000);
    await refreshDailySignals(env, day);
    const running = await computedOn(day);
    await refreshDailySignals(env, new Date(day.getTime() + hourMs));
    const lapsed = await computedOn(day);
    // Claimed three times already: a computation that keeps failing stops.
    for (const ago of [3, 2, 1]) {
      // oxlint-disable-next-line no-await-in-loop -- one claim at a time
      await seedClaim(spent, spent, ago * hourMs);
    }
    await refreshDailySignals(env, spent);

    expect({
      running,
      lapsed,
      spent: await computedOn(spent),
    }).toStrictEqual({ running: 0, lapsed: 1, spent: 0 });
  });

  it("tell a collection's owner about a question others asked there again and again without an answer", async () => {
    const owner = await newOwner();
    const asker = await newReader();
    const collectionId = await newCollection(owner);
    const other = await newCollection(owner);
    await newDocument(owner, collectionId, "leave.md");
    // Twice in the collection by someone else, and once by its owner, who
    // knows what they asked; nothing matches.
    await asker.api.knowledge.search("zebra quota", { collectionId });
    await asker.api.knowledge.search("quota zebra", { collectionId });
    await owner.api.knowledge.search("zebra quota", { collectionId });
    // Asked once only, in another collection.
    await asker.api.knowledge.search("walrus ledger", { collectionId: other });
    const events = await allEvents();
    const asked = events.find(
      ({ action, target }) =>
        action === "knowledge.search.empty" && target?.id === collectionId
    );

    await refreshDailySignals(env, nextDay());

    // The words are nowhere: only their key, the same in any order.
    const listed = await owner.api.knowledgeSignals.list();
    const byAsker = await asker.api.knowledgeSignals.list();
    const signals = await signalsOf(owner, collectionId);
    expect({
      signals: signals.map(({ evidence, ...signal }) => ({
        ...signal,
        evidence: {
          ...evidence,
          lastAt: "lastAt" in evidence && Date.parse(evidence.lastAt) > 0,
        },
      })),
      other: await signalsOf(owner, other),
      asker: byAsker.signals,
      words: JSON.stringify(listed).includes("zebra"),
    }).toStrictEqual({
      signals: [
        {
          kind: "unanswered_question",
          value: 2,
          evidence: {
            queryKey: asked?.detail.queryKey,
            searches: 2,
            askers: 1,
            terms: 2,
            lastAt: true,
          },
        },
      ],
      other: [],
      asker: [],
      words: false,
    });
  });

  it("put a search of every collection that found nothing down to the collections it came closest in", async () => {
    const owner = await newOwner();
    const asker = await newReader();
    const budgets = await newCollection(owner);
    const holidays = await newCollection(owner);
    await newDocument(owner, budgets, "budget.md", {
      body: "The quarterly budget is set in March.",
    });
    await newDocument(owner, holidays, "holidays.md", {
      body: "Everyone gets twenty-five days off.",
    });
    // Nothing has both words; one has one of them.
    await asker.api.knowledge.search("quarterly marzipan");
    await asker.api.knowledge.search("marzipan quarterly");
    // Nothing has either.
    await asker.api.knowledge.search("xylophone yodel");
    await asker.api.knowledge.search("yodel xylophone");
    const events = await allEvents();
    const empty = events.filter(
      ({ action, actor }) =>
        action === "knowledge.search.empty" &&
        actor.type === "person" &&
        actor.userId === asker.userId
    );

    await refreshDailySignals(env, nextDay());

    const nowhere = empty.at(-1)?.detail.queryKey;
    const { signals: improvement } = await owner.api.signals.list();
    const { signals: everywhere } = await owner.api.knowledgeSignals.list();
    expect({
      // Only collection IDs, never words or documents.
      details: empty.map(({ detail: { queryKey: _key, ...detail } }) => detail),
      budgets: questions(await signalsOf(owner, budgets)),
      holidays: await signalsOf(owner, holidays),
      // The one that came close nowhere is only the admins' signal.
      nowhere: everywhere.some(
        (signal) =>
          signal.kind === "unanswered_question" &&
          signal.evidence.queryKey === nowhere
      ),
      admins: improvement.some(
        ({ kind, subject }) =>
          kind === "unanswered_question" && subject === nowhere
      ),
    }).toStrictEqual({
      details: [
        { terms: 2, nearest: budgets, sensitive: false },
        { terms: 2, nearest: budgets, sensitive: false },
        { terms: 2, sensitive: false },
        { terms: 2, sensitive: false },
      ],
      budgets: [{ value: 2, searches: 2, askers: 1 }],
      holidays: [],
      nowhere: false,
      admins: true,
    });
  });

  it("tell the owner about documents past their review date, until the date moves on", async () => {
    const owner = await newOwner();
    const collectionId = await newCollection(owner);
    const overdue = await newDocument(owner, collectionId, "old.md", {
      review: "2020-01-01",
    });
    await newDocument(owner, collectionId, "later.md", {
      review: "2999-01-01",
    });
    await newDocument(owner, collectionId, "none.md");
    const day = nextDay();

    await refreshDailySignals(env, day);
    const before = await signalsOf(owner, collectionId);
    // Reviewed: its next review is years away.
    await owner.api.knowledge.saveDocument({
      collectionId,
      path: "old.md",
      text: "---\nreview: 2999-06-01\n---\n# old.md\n\nChecked.",
      ifVersion: 1,
    });
    const reviewed = await signalsOf(owner, collectionId);
    const next = nextDay();
    await refreshDailySignals(env, next);
    const [computed] = await computationsOf(next);

    expect({
      before,
      reviewed,
      next: await signalsOf(owner, collectionId),
      signals: typeof computed?.detail.signals,
    }).toStrictEqual({
      before: [
        {
          kind: "overdue_review",
          // Days past it as of today, when it is listed.
          value: Math.floor(
            (Date.parse(new Date().toISOString().slice(0, 10)) -
              Date.parse("2020-01-01")) /
              dayMs
          ),
          evidence: {
            document: { id: overdue, path: "old.md", title: "old.md" },
            reviewDate: "2020-01-01",
          },
        },
      ],
      // At once, as the document says so, and the next day too.
      reviewed: [],
      next: [],
      signals: "number",
    });
  });

  it("tell the owner about documents nobody read or changed for 90 days, memory files' reads included", async () => {
    const owner = await newOwner();
    const reader = await newReader();
    const collectionId = await newCollection(owner);
    const day = nextDay();
    const unread = await newDocument(owner, collectionId, "unread.md");
    const read = await newDocument(owner, collectionId, "read.md");
    const memory = await newDocument(owner, collectionId, "AGENTS.md");
    const recent = await newDocument(owner, collectionId, "recent.md");
    for (const id of [unread, read, memory]) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await changedAgo(id, day, 120 * dayMs);
    }
    await changedAgo(recent, day, 10 * dayMs);
    await reader.api.knowledge.read(read);
    // An agent's memory files, read all at once: they're in the read's
    // provenance, beside their collection.
    await logged({
      actor: { type: "agent", agentId: "agent-1", onBehalfOf: reader.userId },
      action: "knowledge.read",
      provenance: [collectionId, memory],
      detail: { read: "memory", sensitive: false },
    });
    // The reader's read in the log, drained from the outbox.
    await allEvents();

    await refreshDailySignals(env, day);

    await expect(signalsOf(owner, collectionId)).resolves.toStrictEqual([
      {
        kind: "unread_document",
        value: 120,
        evidence: {
          document: { id: unread, path: "unread.md", title: "unread.md" },
          updatedAt: new Date(day.getTime() - 120 * dayMs).toISOString(),
          days: 90,
        },
      },
    ]);
  });

  it("count unread documents over the audit log's retention, where that's shorter", async () => {
    const owner = await newOwner();
    const collectionId = await newCollection(owner);
    const day = nextDay();
    const older = await newDocument(owner, collectionId, "older.md");
    const newer = await newDocument(owner, collectionId, "newer.md");
    await changedAgo(older, day, 40 * dayMs);
    await changedAgo(newer, day, 20 * dayMs);

    await refreshDailySignals({ ...env, AUDIT_RETENTION_DAYS: "30" }, day);

    const [computed] = await computationsOf(day);
    expect({
      signals: await signalsOf(owner, collectionId),
      unreadDays: computed?.detail.unreadDays,
    }).toStrictEqual({
      signals: [
        {
          kind: "unread_document",
          value: 40,
          evidence: {
            document: { id: older, path: "older.md", title: "older.md" },
            updatedAt: new Date(day.getTime() - 40 * dayMs).toISOString(),
            days: 30,
          },
        },
      ],
      unreadDays: 30,
    });
  });

  it("keep a dismissed signal away until there is something new", async () => {
    const owner = await newOwner();
    const [first, second] = [await newReader(), await newReader()];
    const someoneElse = await newOwner();
    const collectionId = await newCollection(owner);
    await newDocument(owner, collectionId, "old.md", { review: "2020-01-01" });
    const queryKey = `key-${unique()}`;
    await logged(
      emptySearch(first.userId, queryKey, collectionId),
      emptySearch(second.userId, queryKey, collectionId)
    );
    await refreshDailySignals(env, nextDay());
    const question = await signalOf(owner, collectionId, "unanswered_question");
    const overdue = await signalOf(owner, collectionId, "overdue_review");

    // Only its owner dismisses it.
    const refused = await outcome(
      someoneElse.api.knowledgeSignals.dismiss(question?.id ?? "")
    );
    const invalid = await outcome(owner.api.knowledgeSignals.dismiss("nope"));
    await owner.api.knowledgeSignals.dismiss(question?.id ?? "");
    await owner.api.knowledgeSignals.dismiss(overdue?.id ?? "");
    // Twice changes nothing.
    await owner.api.knowledgeSignals.dismiss(overdue?.id ?? "");
    const dismissed = await signalsOf(owner, collectionId);
    // The next day, with only the owner's own search since: still away.
    await logged(emptySearch(owner.userId, queryKey, collectionId));
    await refreshDailySignals(env, nextDay());
    const ownSearch = await signalsOf(owner, collectionId);
    // Asked again by someone else: back, the overdue document not.
    await logged(emptySearch(first.userId, queryKey, collectionId));
    await refreshDailySignals(env, nextDay());
    const askedAgain = await signalsOf(owner, collectionId);
    const events = await allEvents();
    const dismissals = events.filter(
      ({ action, target }) =>
        action === "knowledge.signal.dismissed" &&
        (target?.id === question?.id || target?.id === overdue?.id)
    );

    expect({
      refused,
      invalid,
      dismissed,
      ownSearch,
      askedAgain: questions(askedAgain),
      kinds: askedAgain.map(({ kind }) => kind),
      dismissals: dismissals.map(({ actor, target }) => ({ actor, target })),
    }).toStrictEqual({
      refused: "knowledge_signal.not_found",
      invalid: "knowledge_signal.invalid",
      dismissed: [],
      ownSearch: [],
      askedAgain: [{ value: 3, searches: 3, askers: 2 }],
      kinds: ["unanswered_question"],
      dismissals: [
        {
          actor: { type: "person", userId: owner.userId },
          target: { type: "knowledge_signal", id: question?.id },
        },
        {
          actor: { type: "person", userId: owner.userId },
          target: { type: "knowledge_signal", id: overdue?.id },
        },
      ],
    });
  });

  it("show the last finished computation's signals while the next is half written", async () => {
    const owner = await newOwner();
    const [first, second, third] = [
      await newReader(),
      await newReader(),
      await newReader(),
    ];
    const collectionId = await newCollection(owner);
    const queryKey = `key-${unique()}`;
    await logged(
      emptySearch(first.userId, queryKey, collectionId),
      emptySearch(second.userId, queryKey, collectionId)
    );
    await refreshDailySignals(env, nextDay());
    await logged(emptySearch(third.userId, queryKey, collectionId));
    // Listed once the next computation has written its signals, just
    // before it finishes.
    let during: ReturnType<typeof questions> = [];
    const racing = racingSignals(
      'update "knowledge_signal_computations"',
      async () => {
        during = questions(await signalsOf(owner, collectionId));
      }
    );

    await refreshDailySignals({ ...env, KNOWLEDGE: racing }, nextDay());

    expect({
      during,
      after: questions(await signalsOf(owner, collectionId)),
    }).toStrictEqual({
      during: [{ value: 2, searches: 2, askers: 2 }],
      after: [{ value: 3, searches: 3, askers: 3 }],
    });
  });

  it("never show what a lapsed computation writes after a newer one finished", async () => {
    const owner = await newOwner();
    const [first, second, third] = [
      await newReader(),
      await newReader(),
      await newReader(),
    ];
    const collectionId = await newCollection(owner);
    const queryKey = `key-${unique()}`;
    await logged(
      emptySearch(first.userId, queryKey, collectionId),
      emptySearch(second.userId, queryKey, collectionId)
    );
    const day = nextDay();
    // Once the older computation has read two searches, and just before it
    // writes them: a third, and a newer computation of the day, an hour
    // later, when the older one's lease is up, that runs whole.
    const racing = racingSignals(
      'insert into "knowledge_signals"',
      async () => {
        await logged(emptySearch(third.userId, queryKey, collectionId));
        await refreshDailySignals(env, new Date(day.getTime() + hourMs));
      }
    );

    await outcome(refreshDailySignals({ ...env, KNOWLEDGE: racing }, day));

    expect({
      signals: questions(await signalsOf(owner, collectionId)),
      computations: await computedOn(day),
    }).toStrictEqual({
      // Its signals are written, but it never finishes past the newer one.
      signals: [{ value: 3, searches: 3, askers: 3 }],
      computations: 1,
    });
  });

  it("keep the previous computation's signals whole for a reader that picked it, until the one after", async () => {
    const owner = await newOwner();
    const [first, second, third] = [
      await newReader(),
      await newReader(),
      await newReader(),
    ];
    const collectionId = await newCollection(owner);
    await newDocument(owner, collectionId, "old.md", { review: "2020-01-01" });
    const queryKey = `key-${unique()}`;
    await logged(
      emptySearch(first.userId, queryKey, collectionId),
      emptySearch(second.userId, queryKey, collectionId)
    );
    await refreshDailySignals(env, nextDay());
    // What a reader that picked the latest computation reads of it.
    const picked = await env.KNOWLEDGE.prepare(
      "SELECT id FROM knowledge_signal_computations WHERE finished_at IS NOT NULL ORDER BY started_at DESC, id DESC LIMIT 1"
    ).first<{ id: string }>();
    const read = async () => {
      const { results } = await env.KNOWLEDGE.prepare(
        "SELECT kind, subject, value FROM knowledge_signals WHERE computation = ? AND collection_id = ? ORDER BY kind, subject"
      )
        .bind(picked?.id ?? "", collectionId)
        .all();
      return results;
    };
    const before = await read();

    // The next computation finishes and cleans up.
    await logged(emptySearch(third.userId, queryKey, collectionId));
    await refreshDailySignals(env, nextDay());
    const whileNext = await read();
    // The one after that cleans it up.
    await refreshDailySignals(env, nextDay());

    expect({
      kinds: before.map(({ kind }) => kind),
      whileNext,
      after: await read(),
      listed: questions(await signalsOf(owner, collectionId)),
    }).toStrictEqual({
      kinds: ["overdue_review", "unanswered_question"],
      whileNext: before,
      after: [],
      listed: [{ value: 3, searches: 3, askers: 3 }],
    });
  });

  it("list the most overdue documents by their review dates as they are now", async () => {
    const owner = await newOwner();
    const collectionId = await newCollection(owner);
    const moved = await newDocument(owner, collectionId, "moved.md", {
      review: "2020-01-01",
    });
    // As many others as a listing holds, all less overdue.
    const now = Date.now();
    await env.KNOWLEDGE.batch(
      Array.from({ length: knowledgeSignalsPerKind }, (_, index) =>
        env.KNOWLEDGE.prepare(
          "INSERT INTO documents (id, collection_id, path, title, type, description, owner, tags, review_date, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, 'doc', '', ?, '[]', '2021-01-01', 1, ?, ?)"
        ).bind(
          crypto.randomUUID(),
          collectionId,
          `other-${index}.md`,
          `Other ${index}`,
          owner.userId,
          now,
          now
        )
      )
    );
    await refreshDailySignals(env, nextDay());
    const overdue = async () => {
      const signals = await signalsOf(owner, collectionId);
      return signals.flatMap((signal) =>
        signal.kind === "overdue_review" ? [signal.evidence] : []
      );
    };
    const before = await overdue();
    const yesterday = new Date(now - dayMs).toISOString().slice(0, 10);

    await env.KNOWLEDGE.prepare(
      "UPDATE documents SET review_date = ? WHERE id = ?"
    )
      .bind(yesterday, moved)
      .run();

    const after = await overdue();
    expect({
      before: {
        count: before.length,
        first: before[0]?.document.id,
      },
      after: {
        count: after.length,
        moved: after.some(({ document }) => document.id === moved),
        dates: [...new Set(after.map(({ reviewDate }) => reviewDate))],
      },
    }).toStrictEqual({
      before: { count: knowledgeSignalsPerKind, first: moved },
      // Now the least overdue of them: it gives its place up.
      after: {
        count: knowledgeSignalsPerKind,
        moved: false,
        dates: ["2021-01-01"],
      },
    });
  });

  it("list the most overdue documents of an owner with many collections", async () => {
    const owner = await newOwner();
    const collectionCount = 200;
    const now = Date.now();
    const reviewDate = (index: number) =>
      new Date(Date.UTC(2020, 0, 1) + index * dayMs).toISOString().slice(0, 10);
    // A collection each, with a document a day less overdue than the last.
    const ids = Array.from({ length: collectionCount }, () =>
      crypto.randomUUID()
    );
    await env.KNOWLEDGE.batch(
      ids.flatMap((id, index) => [
        env.KNOWLEDGE.prepare(
          "INSERT INTO collections (id, name, description, owner, access, sensitive, source, created_at) VALUES (?, ?, '', ?, 'everyone', 0, 'here', ?)"
        ).bind(id, `Many ${index}`, owner.userId, now),
        env.KNOWLEDGE.prepare(
          "INSERT INTO documents (id, collection_id, path, title, type, description, owner, tags, review_date, current_version, created_at, updated_at) VALUES (?, ?, 'due.md', 'Due', 'doc', '', ?, '[]', ?, 1, ?, ?)"
        ).bind(
          crypto.randomUUID(),
          id,
          owner.userId,
          reviewDate(index),
          now,
          now
        ),
      ])
    );
    await refreshDailySignals(env, nextDay());

    const { signals } = await owner.api.knowledgeSignals.list();
    const overdue = signals.flatMap((signal) =>
      signal.kind === "overdue_review" && ids.includes(signal.collection.id)
        ? [signal.evidence.reviewDate]
        : []
    );

    expect(overdue).toStrictEqual(
      Array.from({ length: knowledgeSignalsPerKind }, (_, index) =>
        reviewDate(index)
      )
    );
  });

  it("count how overdue a document is from its review date as it is now", async () => {
    const owner = await newOwner();
    const collectionId = await newCollection(owner);
    const documentId = await newDocument(owner, collectionId, "old.md", {
      review: "2020-01-01",
    });
    await refreshDailySignals(env, nextDay());
    const yesterday = new Date(Date.now() - dayMs).toISOString().slice(0, 10);

    await owner.api.knowledge.saveDocument({
      collectionId,
      path: "old.md",
      text: `---\nreview: ${yesterday}\n---\n# old.md\n\nLooked at, not done.`,
      ifVersion: 1,
    });

    await expect(signalsOf(owner, collectionId)).resolves.toStrictEqual([
      {
        kind: "overdue_review",
        value: 1,
        evidence: {
          document: { id: documentId, path: "old.md", title: "old.md" },
          reviewDate: yesterday,
        },
      },
    ]);
  });

  it("record every listing in the audit log", async () => {
    const owner = await newOwner();
    const collectionId = await newCollection(owner);
    await newDocument(owner, collectionId, "old.md", { review: "2020-01-01" });
    await refreshDailySignals(env, nextDay());

    const listed = await owner.api.knowledgeSignals.list();
    const events = await allEvents();
    const reads = events.filter(
      ({ action, actor }) =>
        action === "knowledge.signals.read" &&
        actor.type === "person" &&
        actor.userId === owner.userId
    );

    expect({
      computedAt: listed.computedAt === null,
      reads: reads.length,
    }).toStrictEqual({ computedAt: false, reads: 1 });
  });

  it("compute nothing, and give an agent nothing, while switched off", async () => {
    const owner = await newOwner();
    const off: Env = {
      ...env,
      FEATURES: { knowledge: true, improvement_signals: true },
    };
    const day = nextDay();

    await refreshDailySignals(off, day);
    const agent = await outcome(
      agentKnowledgeSignals(
        off,
        { type: "person", person: await owner.api.whoami() },
        owner.userId
      )
    );

    expect({
      knowledge: await computedOn(day),
      improvement: await computedOn(day, "improvement.signals.computed"),
      agent,
    }).toStrictEqual({
      knowledge: 0,
      improvement: 1,
      agent: "feature.disabled",
    });
  });

  it("read the documents, signals and searches by index, never a whole table", async () => {
    const owner = await newOwner();
    const collectionId = await newCollection(owner);
    const day = nextDay();
    const documentId = await newDocument(owner, collectionId, "old.md", {
      review: "2020-01-01",
    });
    await changedAgo(documentId, day, 120 * dayMs);
    await logged(
      emptySearch("someone", "key-a", collectionId),
      emptySearch("someone", "key-a", collectionId)
    );

    const queries = await recordedQueries(async () => {
      await refreshDailySignals(env, day);
      const { signals } = await owner.api.knowledgeSignals.list();
      await owner.api.knowledgeSignals.dismiss(signals[0]?.id ?? "");
      // A search of every collection that finds nothing, and so looks
      // where it came closest.
      await owner.api.knowledge.search("old marzipan");
    }, "KNOWLEDGE");
    // Those of the signals, their computations, documents, collections and
    // searches; an insert's list of values is no table, nor is a CTE of
    // search matches, and ranking the matches sorts them.
    const plans = await Promise.all(
      queries
        .filter(
          ({ query }) =>
            query.includes('"knowledge_signal') ||
            query.includes('"documents"') ||
            query.includes('from "collections"') ||
            query.includes("search_rows")
        )
        // The improvement signals' read of Playbook records, their own.
        .filter(({ query }) => !query.includes('"versions"'))
        .map(async (recorded) => {
          const plan = await planOf(recorded);
          const search = recorded.query.includes("search_rows");
          // The overdue listing sorts by the review date documents have
          // now: a sort of that owner's own overdue signals, read by
          // their index, so bounded by their data.
          const overdue =
            recorded.query.includes('from "knowledge_signals"') &&
            recorded.query.includes('order by "documents"."review_date"');
          return {
            query: recorded.query,
            plan: plan.filter(
              (step) =>
                !step.endsWith("VALUES CLAUSE") &&
                step !== "SCAN CONSTANT ROW" &&
                !((search || overdue) && step.includes("TEMP B-TREE")) &&
                !(
                  search &&
                  /^SCAN (?:matches|readable|found|ranked|top)\b/u.test(step)
                )
            ),
          };
        })
    );

    expect(
      plans.filter(({ plan }) =>
        plan.some((step) => fullScan.test(step) || step.includes("TEMP B-TREE"))
      )
    ).toStrictEqual([]);
    // The claim, the documents, the upsert, the finish, the list, the
    // dismissal and the searches, at least.
    expect({
      many: plans.length > 8,
      searches: plans.filter(({ query }) => query.includes("search_rows"))
        .length,
      // The overdue listing starts from the owner's signals.
      overdueByOwner: plans.some(
        ({ query, plan }) =>
          query.includes('order by "documents"."review_date"') &&
          plan[0]?.includes("knowledge_signals_owner_idx") === true
      ),
    }).toStrictEqual({ many: true, searches: 2, overdueByOwner: true });
  });
});

describe("Knowledge usage signals over a long audit log", () => {
  /** Appends `count` events no signal counts, 500 at a time. */
  const filler = async (count: number): Promise<void> => {
    for (let start = 0; start < count; start += 500) {
      // oxlint-disable-next-line no-await-in-loop -- appended in order
      await logged(
        ...Array.from({ length: Math.min(500, count - start) }, () => ({
          action: "knowledge.catalog",
        }))
      );
    }
  };

  /**
   * The env, whose audit log retention archives `stretches` stretches of
   * it right after the first stretch a computation reads.
   */
  const archivingMidPass = (stretches: number): Env => {
    let archived = false;
    const archive = async (): Promise<void> => {
      await runInDurableObject(auditLog(env), async (instance) => {
        const cutoff = new Date(Date.now() + dayMs).toISOString();
        for (let stretch = 0; stretch < stretches; stretch += 1) {
          // oxlint-disable-next-line no-await-in-loop -- oldest first
          await instance.archive(cutoff, 30);
        }
      });
    };
    const namespace = new Proxy(env.AUDIT_LOG, {
      get: (target, property) => {
        if (property !== "getByName") {
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        }
        return (name: string) => {
          const stub = target.getByName(name);
          return new Proxy(stub, {
            get: (inner, key) => {
              if (key === "tallyStretch") {
                return async (
                  ...args: Parameters<typeof inner.tallyStretch>
                ) => {
                  const stretch = await inner.tallyStretch(...args);
                  if (!archived) {
                    archived = true;
                    await archive();
                  }
                  return stretch;
                };
              }
              const value: unknown = Reflect.get(inner, key);
              return typeof value === "function"
                ? (...args: unknown[]): unknown =>
                    Reflect.apply(value, inner, args)
                : value;
            },
          });
        };
      },
    });
    return { ...env, AUDIT_LOG: namespace };
  };

  it("add a question up across stretches, and past what retention archives mid-pass", async () => {
    const owner = await newOwner();
    const [first, second] = [await newReader(), await newReader()];
    const collectionId = await newCollection(owner);
    const queryKey = `key-${unique()}`;
    // Within the first stretch a pass reads (5,000 entries)…
    await expect(logHead()).resolves.toBeLessThan(4000);
    await logged(emptySearch(first.userId, queryKey, collectionId));
    await filler(5600);
    // …and well past it, and past what retention archives below.
    await logged(emptySearch(second.userId, queryKey, collectionId));

    await refreshDailySignals(env, nextDay());
    const across = questions(await signalsOf(owner, collectionId));
    // Retention archives 5,500 entries once the first stretch is read:
    // the pass carries on from what the log still holds.
    const archiving = nextDay();
    await refreshDailySignals(archivingMidPass(11), archiving);
    const [computed] = await computationsOf(archiving);

    expect({
      across,
      archiving: questions(await signalsOf(owner, collectionId)),
      unreadDays: computed?.detail.unreadDays,
    }).toStrictEqual({
      across: [{ value: 2, searches: 2, askers: 2 }],
      archiving: [{ value: 2, searches: 2, askers: 2 }],
      // Reads were archived before the pass read them.
      unreadDays: null,
    });
  });
});
