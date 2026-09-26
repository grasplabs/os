import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import type { AppId, RunId, WorkflowId } from "./ids.ts";
import type { Json } from "./json.ts";

// A decision is a person's answer a workflow run waits for
// (`step.decision`). Only the people the decision is `from` answer it,
// signed in, each time checked against who they are then, and never the
// run's starter, unless `from` is exactly `person:<them>`; a decision link
// (`/decisions/<id>`) only leads them to it (threat model R8, decision Q5).

const decidersPattern =
  /^(?:person:[\w-]{1,128}|role:(?:admin|builder|user)|team:[\w-]{1,128})$/u;

/**
 * Who answers a decision: one person (`person:<user ID>`), everyone with
 * a role (`role:admin`, exactly that role), or everyone in a team
 * (`team:<team ID>`), as they are when someone answers.
 */
export const decidersSchema = z
  .string()
  .regex(
    decidersPattern,
    'a person ("person:<user ID>"), a role ("role:admin") or a team ("team:<team ID>")'
  );

/** Why a decision call was refused. */
export const decisionErrors = defineErrorFamily({
  "decision.invalid": "That isn't a valid answer to a decision.",
  "decision.not_found": "There's no such decision.",
  "decision.forbidden":
    "You aren't one of the people who answer this decision.",
  "decision.closed":
    "This decision has been answered, has timed out, or its run has ended.",
  "decision.too_many_deciders":
    "A decision asks at most 50 people: ask a smaller team or a role with fewer people.",
});

/**
 * The most people one decision asks, so asking stays one email each. It
 * counts only the people who may answer: the run's starter counts only
 * when `from` is exactly `person:<them>`, never as part of a role or team.
 */
export const maxDeciders = 50;

/** Where a decision stands; `closed` once its run ended while it was open. */
export type DecisionStatus =
  | "open"
  | "approved"
  | "rejected"
  | "timed_out"
  | "closed";

/** A decision as the people who answer it see it. */
export interface DecisionView {
  id: string;
  app: { id: AppId; name: string };
  workflow: WorkflowId;
  run: RunId;
  /** What is decided, as the workflow's code describes the step. */
  description: string;
  status: DecisionStatus;
  /** ISO 8601: no answer is taken from then on. */
  expiresAt: string;
  /** Who answered, and when; only once answered. */
  decided?: {
    by: { userId: string; name: string };
    at: string;
  };
}

/** What a person answers. */
export interface DecisionAnswerInput {
  approved: boolean;
  /**
   * Anything more the workflow asks for, e.g. `{ comment }`: JSON, at most
   * 4 KiB. The workflow gets it as it is, as untrusted input.
   */
  payload?: Json;
}

/**
 * A signed-in person's decisions. Every call checks the session, and that
 * the person is one the decision is from, as they are now: never the run's
 * starter, unless `from` is exactly `person:<them>`.
 */
export interface DecisionsApi {
  /** A decision the person may answer. */
  get: (decision: string) => Promise<DecisionView>;
  /** Answers a decision, once: the first answer is the decision. */
  answer: (
    decision: string,
    answer: DecisionAnswerInput
  ) => Promise<DecisionView>;
}
