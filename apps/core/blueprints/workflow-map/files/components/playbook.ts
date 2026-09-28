// What the map's server answers (app/server.ts), as its screen reads it.

import type { WorkflowRecord } from "./totals";

/** A workflow record, at its current version or an earlier one. */
export interface Workflow {
  id: string;
  path: string;
  version: number;
  record: Record<string, unknown>;
  body: string;
}

/** A team the map groups workflows by. */
export interface Team {
  path: string;
  title: string;
}

/** A server call's answer, or the code of why it was refused. */
export type Outcome<T> = { ok: T } | { error: string };

export interface Overview {
  access: "none" | "ok";
  /**
   * Whether the person using the map may change the Playbook, as the
   * Playbook says (only admins may): when not, the map is read only.
   */
  writable: boolean;
  workflows: Workflow[];
  /** Workflows listed whose record couldn't be read, by path and title. */
  unreadable: { path: string; title: string }[];
  teams: Team[];
}

export interface Opened {
  current: Workflow;
  drawn: Workflow | null;
}

/** A workflow's fields as stored, which may leave its lists out. */
type Stored = Omit<WorkflowRecord, "steps" | "parameters"> &
  Partial<Pick<WorkflowRecord, "steps" | "parameters">>;

/** A workflow's fields, with the lists it may leave out filled in. */
export const recordOf = (workflow: Workflow): WorkflowRecord => {
  // SAFETY: the server lists only documents of type `workflow`, whose
  // frontmatter the Playbook checked against its workflow schema on save,
  // and reads them back with that schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const record = workflow.record as Stored;
  return {
    ...record,
    steps: record.steps ?? [],
    parameters: record.parameters ?? [],
  };
};

/** What a refusal means to the person using the map. */
export const refusal = (code: string): string => {
  switch (code) {
    case "knowledge.conflict": {
      return "Someone saved this workflow since you opened it. Open it again to see their changes.";
    }
    case "knowledge.forbidden": {
      return "Only admins change the Playbook.";
    }
    case "knowledge.invalid": {
      return "That isn't a valid workflow: check each step has a name, and each number is between 0 and 10,000.";
    }
    case "permission.denied": {
      return "The map can't use the Playbook: an admin approves its permission first.";
    }
    case "permission.restricted": {
      return "The map read restricted data, so it can't write to the Playbook, which everyone reads.";
    }
    case "app.unreachable": {
      return "Grasp can't be reached right now, so nothing was saved. Try again in a moment.";
    }
    case "app.not_found": {
      return "There's no such App, or you can't open it.";
    }
    default: {
      return `That didn't work (${code}).`;
    }
  }
};
