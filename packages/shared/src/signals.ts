import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import {
  appIdSchema,
  collectionIdSchema,
  documentIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "./ids.ts";

// Improvement signals: where the Playbook's Evaluate step should look,
// read from runs, decisions and the audit log, and computed once a day
// (core's src/signals.ts). Each signal names where it was seen (an App's
// workflow, or the deployment), what it is about, a value to rank it by,
// and its evidence: IDs and counts, never what a run read, returned or
// failed with, what a decision describes or was answered with, or what
// anyone searched for.
//
// Admins see every signal whole. An App's builders see its signals as
// they see its runs (a run's details are its person's and admins'): the
// counts, the step names and error codes (literals of the App's own code,
// added up), but no run's or decision's ID (`oldest`, `recent`,
// `costliest` are left out) and no person a decision waits for (a
// `person:<id>` subject is `person`).

/** The days of runs, decisions and audit events a computation reads. */
export const signalWindowDays = 30;

/**
 * Runs waiting longest for a person to decide: every decision open now,
 * however long ago it opened, not only those of the last
 * `signalWindowDays` days. It is a snapshot of who is waited for, and a
 * decision open for months is the worst wait, the one this signal is for.
 */
const waitingSchema = z.object({
  kind: z.literal("waiting_for_person"),
  /** Milliseconds the oldest open decision has waited. */
  value: z.number(),
  evidence: z.object({
    /** Open decisions of the workflow for these deciders. */
    open: z.int(),
    /** The oldest of them, oldest first; admins only. */
    oldest: z
      .array(
        z.object({
          decision: z.string(),
          run: runIdSchema,
          step: z.string(),
          openedAt: z.iso.datetime(),
        })
      )
      .optional(),
  }),
});

/** Steps runs failed at, in the window. */
const failingStepSchema = z.object({
  kind: z.literal("failing_step"),
  /** Runs that failed at the step. */
  value: z.number(),
  evidence: z.object({
    failures: z.int(),
    /** Runs of the workflow started in the window, to compare with. */
    runs: z.int(),
    /** The error codes they failed with, most first. */
    errors: z.array(z.object({ code: z.string(), count: z.int() })),
    /** The latest runs that failed there, latest first; admins only. */
    recent: z.array(runIdSchema).optional(),
  }),
});

/**
 * Decisions that changed what the workflow proposed: answered with a
 * rejection, in the window.
 */
const correctionSchema = z.object({
  kind: z.literal("correction"),
  /** Decisions of the step rejected. */
  value: z.number(),
  evidence: z.object({
    /** Decisions of the step answered, approved or rejected. */
    answered: z.int(),
    rejected: z.int(),
    /** The latest rejected, latest first; admins only. */
    recent: z
      .array(z.object({ decision: z.string(), run: runIdSchema }))
      .optional(),
  }),
});

/**
 * What a workflow's runs cost in model calls, against the time it saves:
 * the runs started in the window, and what they spent in it. The window
 * rolls (the last `signalWindowDays` days), while model budgets count a
 * UTC calendar month, so the two don't match.
 */
const costSchema = z.object({
  kind: z.literal("cost_per_run"),
  /** US dollars of model calls per run. */
  value: z.number(),
  evidence: z.object({
    /** Runs of the workflow started in the window. */
    runs: z.int(),
    /** US dollars those runs' model calls cost in the window. */
    cost: z.number(),
    /**
     * Minutes each run saves, by the Playbook workflow record linked to
     * it: from its automated steps' numbers (`steps`), or else its
     * expected gain spread over the runs (`gain`); null without either.
     */
    minutesSavedPerRun: z.number().nullable(),
    savedFrom: z.enum(["steps", "gain"]).nullable(),
    /** The Playbook workflow record linked to the workflow. */
    record: documentIdSchema.nullable(),
    /** US dollars per hour saved; null while nothing is known saved. */
    costPerHourSaved: z.number().nullable(),
    /** The runs that cost most, most first; admins only. */
    costliest: z
      .array(z.object({ run: runIdSchema, cost: z.number() }))
      .optional(),
  }),
});

/**
 * The same Knowledge search that found nothing, asked again: by an App's
 * code and runs (the App's signal), or by people and agents (the
 * deployment's). Grouped by the search's key, an HMAC of its words, never
 * the words.
 */
const unansweredSchema = z.object({
  kind: z.literal("unanswered_question"),
  /** Times it was searched in the window. */
  value: z.number(),
  evidence: z.object({
    searches: z.int(),
    /**
     * How many different people, agents, App parts (screens or server
     * code) or runs searched it.
     */
    askers: z.int(),
    /** How many words it had. */
    terms: z.int(),
    /**
     * The collections it was searched in, a few at most; a search of every
     * collection the asker may read adds none.
     */
    collections: z.array(collectionIdSchema),
    /** When the audit log received the latest search (ISO 8601). */
    lastAt: z.iso.datetime(),
  }),
});

/** One improvement signal. */
export const improvementSignalSchema = z
  .discriminatedUnion("kind", [
    waitingSchema,
    failingStepSchema,
    correctionSchema,
    costSchema,
    unansweredSchema,
  ])
  .and(
    z.object({
      /** The App it was seen in; null for the deployment's own. */
      app: appIdSchema.nullable(),
      /** The App's workflow it was seen in; null for none. */
      workflow: workflowIdSchema.nullable(),
      /**
       * What it is about: the deciders (`role:admin`; `person` for one
       * person, but to admins), the step, the search's key; null when the
       * workflow itself is.
       */
      subject: z.string().nullable(),
    })
  );
export type ImprovementSignal = z.infer<typeof improvementSignalSchema>;
export type SignalKind = ImprovementSignal["kind"];

/** Every kind of signal. */
export const signalKinds = [
  "waiting_for_person",
  "failing_step",
  "correction",
  "cost_per_run",
  "unanswered_question",
] as const satisfies readonly SignalKind[];

/** Most signals of each kind one `list` returns, highest value first. */
export const signalsPerKind = 50;

/** The signals as of the latest computation. */
export interface ImprovementSignals {
  /** When they were computed (ISO 8601); null before the first time. */
  computedAt: string | null;
  signals: ImprovementSignal[];
}

/** Which signals to list. */
export const signalFilterSchema = z
  .strictObject({
    app: appIdSchema.optional(),
    /** Only with `app`, and one its running version has. */
    workflow: workflowIdSchema.optional(),
  })
  .refine(({ app, workflow }) => workflow === undefined || app !== undefined, {
    path: ["workflow"],
    message: "Only with app",
  })
  .default({});
export type SignalFilter = z.input<typeof signalFilterSchema>;

/** Why a signals call was refused. */
export const signalErrors = defineErrorFamily({
  "signal.invalid": "That isn't a valid request for improvement signals.",
});

/**
 * Improvement signals. Admins list every signal; an App's builders list
 * that App's (`{ app }`, or one workflow of it), without run, decision or
 * person IDs. Every read is audited.
 */
export interface SignalsApi {
  /**
   * The signals as of the latest daily computation, at most
   * {@link signalsPerKind} of each kind, highest value first.
   */
  list: (filter?: SignalFilter) => Promise<ImprovementSignals>;
}
