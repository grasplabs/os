import type { AuditActor, AuditEvent } from "@grasp-os/shared/audit";

// What the improvement signals (signals.ts) need of the audit log: model
// calls' cost per workflow run, and Knowledge searches that found nothing,
// per scope, key and asker. The AuditLog object tallies one stretch of the
// log at a time with these (`AuditLog.tallyStretch`), so only small
// partial totals cross to the Worker, which adds them up.

/** The most collections a tallied question keeps. */
export const collectionsPerQuestion = 5;

/** A workflow run's model calls in a stretch: their cost in US dollars. */
export interface RunCost {
  appId: string;
  workflowId: string;
  runId: string;
  cost: number;
}

/**
 * One asker's searches for one key in a stretch: `appId` and `workflowId`
 * are the App (and workflow) whose code asked, empty for people and agents.
 */
export interface QuestionTally {
  appId: string;
  workflowId: string;
  queryKey: string;
  asker: string;
  searches: number;
  terms: number;
  collections: string[];
  /** When the log received the latest of them (ISO 8601). */
  lastAt: string;
}

/** A stretch's partial totals. */
export interface SignalTally {
  costs: RunCost[];
  questions: QuestionTally[];
}

/**
 * Who asked, for counting how many different askers a question had: the
 * person, the App's part, or the run. An agent asks for a person, and
 * every chat's is the same agent, so its asker is that person: people
 * asking through it are each an asker of their own, and an owner asking
 * through it is still the owner.
 */
export const askerOf = (actor: AuditActor): string => {
  switch (actor.type) {
    case "person":
    case "staff": {
      return `person:${actor.userId}`;
    }
    case "agent": {
      return `person:${actor.onBehalfOf}`;
    }
    case "app": {
      return `app:${actor.appId}:${actor.part}`;
    }
    case "workflow": {
      return `run:${actor.runId}`;
    }
    case "system": {
      return "system";
    }
    default: {
      return "unknown";
    }
  }
};

/**
 * Tallies events, one after another, oldest first: those the log received
 * from `from` (ISO 8601) on, as a stretch may start earlier for the
 * Knowledge usage signals it is read for too.
 */
export class SignalTallier {
  readonly #from: string;
  readonly #costs = new Map<string, RunCost>();
  readonly #questions = new Map<string, QuestionTally>();

  constructor(from: string) {
    this.#from = from;
  }

  add(event: AuditEvent, receivedAt: string): void {
    if (receivedAt < this.#from) {
      return;
    }
    const { action, actor } = event;
    if (action === "model.call" && actor.type === "workflow") {
      if (event.cost?.currency !== "USD") {
        return;
      }
      const found = this.#costs.get(actor.runId) ?? {
        appId: actor.appId,
        workflowId: actor.workflowId,
        runId: actor.runId,
        cost: 0,
      };
      found.cost += event.cost.amount;
      this.#costs.set(actor.runId, found);
      return;
    }
    if (action === "knowledge.search.empty") {
      this.#addQuestion(event, receivedAt);
    }
  }

  #addQuestion({ actor, detail, target }: AuditEvent, receivedAt: string) {
    const { queryKey, terms } = detail;
    if (typeof queryKey !== "string") {
      return;
    }
    const appId =
      actor.type === "app" || actor.type === "workflow" ? actor.appId : "";
    const workflowId = actor.type === "workflow" ? actor.workflowId : "";
    const asker = askerOf(actor);
    const key = JSON.stringify([appId, workflowId, queryKey, asker]);
    const found = this.#questions.get(key) ?? {
      appId,
      workflowId,
      queryKey,
      asker,
      searches: 0,
      terms: typeof terms === "number" ? terms : 0,
      collections: [],
      lastAt: receivedAt,
    };
    found.searches += 1;
    found.lastAt = receivedAt;
    if (
      target?.type === "collection" &&
      found.collections.length < collectionsPerQuestion &&
      !found.collections.includes(target.id)
    ) {
      found.collections.push(target.id);
    }
    this.#questions.set(key, found);
  }

  totals(): SignalTally {
    return {
      costs: [...this.#costs.values()],
      questions: [...this.#questions.values()],
    };
  }
}
