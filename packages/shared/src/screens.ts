import { z } from "zod";

import type { DecisionAnswerInput, DecisionView } from "./decisions.ts";
import { defineErrorFamily } from "./errors.ts";
import type { AppId } from "./ids.ts";
import type { WorkflowRun } from "./workflows.ts";

// An App's screens run in a sandboxed frame in the frontend (apps/web):
// the page builds the frame's import map from a screen's modules, the kit
// modules they need and their CSS, and connects the frame to its App's
// server through core. Core checks the person's session and role on every
// call; the frame only ever talks to the page.

/** Where the frontend frames screens from: a document core serves. */
export const screenFramePath = "/screen-frame";

/**
 * What the frame posts to the page once it listens for its screen:
 * `{ type, load }`, with the `load` its address carried, so the page can
 * tell this load of the frame from an earlier one.
 */
export const screenFrameReady = "grasp:screen-ready";

/**
 * What the page posts the frame, with a `MessagePort`, to start the
 * screen: `{ type, imports, css, runtime, entry }`.
 */
export const screenFrameMessage = "grasp:screen";

/** A screen's name: `desk` for `screens/desk.tsx`. */
export const screenNameSchema = z
  .string()
  .regex(/^[\w-]{1,64}$/u, "a screen's file name, without .tsx");

/** A screen's file, `screens/<name>.tsx`: its name is the `name` group. */
export const screenPath = /^screens\/(?<name>[\w-]{1,64})\.tsx$/u;

/** One of an App's screens at its current version, ready for a frame. */
export interface ScreenBundle {
  app: AppId;
  /** The App's name, which the page shows around the frame. */
  name: string;
  /** The App's current version, which the screen was built from. */
  version: number;
  screen: string;
  /** The module to render: its default export is the screen. */
  entry: string;
  /** The kit module that renders it in the frame (@grasp-os/sdk/screen-runtime). */
  runtime: string;
  /** The App's modules by flat name. */
  modules: Record<string, string>;
  /** The kit's modules the App's modules need, by flat name, with their code. */
  kit: Record<string, string>;
  css: string;
}

/** The most one problem report may carry, in characters. */
const reportLimits = { message: 2000, stack: 8000 } as const;

/**
 * A problem in a screen, as the frame reports it: an uncaught error, an
 * unhandled rejection or a `console.error` call. Written by App code, so
 * it is held to size and never counts as more than text.
 */
export const screenProblemSchema = z.strictObject({
  kind: z.enum(["error", "rejection", "console"]),
  message: z.string().transform((text) => text.slice(0, reportLimits.message)),
  stack: z
    .string()
    .transform((text) => text.slice(0, reportLimits.stack))
    .optional(),
});
export type ScreenProblem = z.output<typeof screenProblemSchema>;

/** What an App's server code wrote with `console`, one call at a time. */
export interface ServerLog {
  /** When, ISO 8601. */
  at: string;
  level: "debug" | "info" | "log" | "warn" | "error";
  /** Its arguments as text, held to size. */
  message: string;
  /** The server method whose call wrote it, when the runtime says. */
  method: string | null;
}

/**
 * One entry of an App's error log: a problem one of its screens reported,
 * or a line its server code wrote with `console`. Times are ISO 8601.
 */
export type AppErrorEntry =
  | (ScreenProblem & {
      at: string;
      source: "screen";
      version: number;
      screen: string;
    })
  | (ServerLog & { source: "server"; version: number });

/** A decision a run waits for, as its App's screens see it. */
export interface WaitingDecision {
  /** Its name in the workflow (`step.decision(name, …)`), with its key. */
  name: string;
  /**
   * What it asks, as the workflow describes it: only for whoever sees the
   * run's details (its starter, admins) or may answer the decision. It is
   * written by workflow code, and can hold what the run read.
   */
  description?: string;
  /** Its deadline, ISO 8601: no answer counts after it. */
  expiresAt: string;
}

/**
 * A run as its App's screens see it: `waiting` exactly while a decision of
 * it is open, with the decisions it waits for; `running` while it waits
 * on anything else; none once it has ended. While decisions are switched
 * off, it waits for none, as nobody can answer one.
 */
export interface ScreenRun extends WorkflowRun {
  waitingFor: WaitingDecision[];
}

/**
 * What core tells a screen following its App's runs (`watchRuns`): which
 * run changed. The screen reads it again (`run`, `runs`), as its person.
 */
export interface RunChange {
  run: string;
}

/**
 * A screen's hold on its App's runs of one workflow (`watchRuns`), until
 * it releases it: then core calls its callback no more, and the slot it
 * took of the 20 a screen may hold is free again.
 */
export interface RunSubscriptionApi {
  release: () => Promise<void>;
}

/**
 * A signed-in person's way to an App's screens: for anyone with a role in
 * the App (`AppsApi`); its error log for its builders only.
 */
export interface ScreensApi {
  /** A screen of the App, built from its current version. */
  open: (app: string, screen: string) => Promise<ScreenBundle>;
  /**
   * Calls `method` of the App's server with `args`, as the person. Plain
   * data, and functions (callbacks the server may keep and call later
   * with plain data). The answer is plain data, whatever it holds.
   */
  call: (app: string, method: string, args: unknown[]) => Promise<unknown>;
  /** The App's current version; null while it has none. */
  version: (app: string) => Promise<number | null>;
  /** Adds a problem in a screen at `version` to the App's error log. */
  report: (
    app: string,
    at: { version: number; screen: string },
    problem: ScreenProblem
  ) => Promise<void>;
  /** The App's error log, newest first. */
  errors: (app: string) => Promise<AppErrorEntry[]>;
  /**
   * Starts a run of the App's workflow, for the person: anyone with a role
   * in the App. Audited as started on a screen (`via: "screen"`). Behind
   * `screen_workflows`, as are the calls below.
   */
  startRun: (
    app: string,
    workflow: string,
    input?: unknown
  ) => Promise<WorkflowRun>;
  /** The App's latest 100 runs of `workflow`, newest first. */
  runs: (app: string, workflow: string) => Promise<ScreenRun[]>;
  /** One of the App's runs as it is now; another App's is not found. */
  run: (app: string, run: string) => Promise<ScreenRun>;
  /**
   * Answers the decision `decision` (its name in the workflow) of one of
   * the App's runs, as the person, by the decision's own rules: only
   * someone it is from, and never the run's starter unless it names
   * exactly them. Audited as answered on a screen (`via: "screen"`).
   */
  decide: (
    app: string,
    run: string,
    decision: string,
    answer: DecisionAnswerInput
  ) => Promise<DecisionView>;
  /**
   * Calls `onChange` each time one of the App's runs of `workflow` starts,
   * waits for a decision, has it answered or closed, or ends, for as long
   * as the person may use the App and until the screen releases the
   * subscription it answers. Core lets go of `onChange` when it stops
   * calling it, which tells the screen to follow again. One screen's
   * connection holds at most 20 subscriptions at once.
   */
  watchRuns: (
    app: string,
    workflow: string,
    onChange: (change: RunChange) => void
  ) => Promise<RunSubscriptionApi>;
}

/** Why a call to an App's screens was refused. */
export const screenErrors = defineErrorFamily({
  "screen.not_found": "The App has no such screen.",
  "screen.build_failed": "The App's screens don't build.",
  "screen.invalid": "That isn't a valid request for a screen.",
  "screen.too_many_subscriptions":
    "A screen follows at most 20 workflows' runs at a time.",
});
