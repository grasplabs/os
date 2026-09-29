// A workflow record as the Playbook keeps it, and the numbers the map
// shows for it: how many hours a week it takes, how many people and
// handovers it has, and what a designed workflow is expected to save
// against the drawn one.

export type Basis = "estimated" | "observed";

/** A number, and whether it was estimated or observed. */
export interface StepNumber {
  value: number;
  basis: Basis;
}

/** How a designed step is done. */
export type StepKind = "automated" | "ai_checked" | "tool" | "instruction";

export const stepKinds: readonly { value: StepKind; label: string }[] = [
  { value: "automated", label: "Automated" },
  { value: "ai_checked", label: "AI, checked by a person" },
  { value: "tool", label: "Tool" },
  { value: "instruction", label: "Instruction" },
];

/** The numbers of a step: times a week, minutes each time, people each time. */
export type NumberName = "frequency" | "minutes" | "people";

export const numberNames: readonly { name: NumberName; label: string }[] = [
  { name: "frequency", label: "Times a week" },
  { name: "minutes", label: "Minutes" },
  { name: "people", label: "People" },
];

export interface Step {
  name: string;
  who?: string;
  tool?: string;
  handover: boolean;
  kind?: StepKind;
  numbers?: Partial<Record<NumberName, StepNumber>>;
}

export interface Parameter {
  name: string;
  value?: string;
}

/** A workflow record's fields, as the Playbook reads them. */
export interface WorkflowRecord {
  type: "workflow";
  title?: string;
  state: "drawn" | "designed";
  /** Its team's record, by path. */
  team?: string;
  steps: Step[];
  parameters: Parameter[];
  gain?: { hoursPerWeek: number };
  /** The App workflow built from it, once linked. */
  app?: { appId: string; workflowId: string };
}

/** What the map shows of a workflow. */
export interface Totals {
  hoursPerWeek: number;
  /** Who does its steps, each once. */
  people: number;
  handovers: number;
  /** Observed only when every number it has was observed. */
  basis: Basis;
}

const minutesPerHour = 60;

/**
 * The hours a week a step takes: times a week × minutes × people. A step
 * without a frequency or minutes takes no time yet; one without people is
 * done by one person.
 */
export const stepHours = (step: Step): number => {
  const { frequency, minutes, people } = step.numbers ?? {};
  return (
    ((frequency?.value ?? 0) * (minutes?.value ?? 0) * (people?.value ?? 1)) /
    minutesPerHour
  );
};

/** The totals of a workflow's steps. */
export const totalsOf = (steps: readonly Step[]): Totals => {
  const who = new Set(
    steps.flatMap((step) => {
      const name = step.who?.trim().toLowerCase() ?? "";
      return name === "" ? [] : [name];
    })
  );
  const numbers = steps.flatMap((step) =>
    Object.values(step.numbers ?? {}).filter((value) => value !== undefined)
  );
  const observed =
    numbers.length > 0 && numbers.every(({ basis }) => basis === "observed");
  return {
    hoursPerWeek: steps.reduce((total, step) => total + stepHours(step), 0),
    people: who.size,
    handovers: steps.filter((step) => step.handover).length,
    basis: observed ? "observed" : "estimated",
  };
};

/**
 * The hours a week the designed steps save against the drawn ones, to a
 * tenth of an hour: never less than nothing.
 */
export const expectedGain = (
  drawn: readonly Step[],
  designed: readonly Step[]
): number => {
  const saved = totalsOf(drawn).hoursPerWeek - totalsOf(designed).hoursPerWeek;
  return Math.max(0, Math.round(saved * 10) / 10);
};

// The workflow record type's limits (app/records.json, which the Playbook
// checks again on every save). Each input is bounded; the gain is worked out from them, and a
// product of in-range numbers can still pass its limit, so the map checks
// it before saving (record.ts `draftProblem`).

/** Largest number a step has: times a week, minutes or people. */
export const stepNumberMax = 10_000;

/** Most hours a week a workflow may be expected to save. */
export const gainMaxHoursPerWeek = 100_000;

/** Most steps one workflow has. */
export const stepsMax = 100;

/** Most parameters one workflow has. */
export const parametersMax = 50;

/** Longest a name, a role or a tool is, in characters. */
export const shortTextMax = 200;

/** Longest a parameter's value is, in characters. */
export const parameterValueMax = 1000;

/** Hours, as the map shows them: `12.5 h`. */
export const formatHours = (hours: number): string =>
  `${(Math.round(hours * 10) / 10).toLocaleString("en", { maximumFractionDigits: 1 })} h`;
