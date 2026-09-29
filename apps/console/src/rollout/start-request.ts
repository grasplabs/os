/**
 * What the rollouts page's start form sends: the rollout its choices name,
 * as `startRolloutFn` takes it. Kept apart from the page so what each
 * choice sends is tested without a browser.
 */
import { InvalidFieldError } from "../use-action.ts";
import type { StartRolloutInput } from "./control.ts";

/** What a rollout takes to clients: a release, or the shared secrets alone. */
export type RolloutKind = StartRolloutInput["kind"];

/** Whom a rollout reaches after ring 0. */
export type ScopeKind = StartRolloutInput["scope"]["scope"];

/** The form's choices, its text fields trimmed. */
export interface StartChoices {
  what: RolloutKind;
  /** The release field; unused for a secrets rollout. */
  releaseId: string;
  scope: ScopeKind;
  /** The ring picked, for `scope: "ring"`. */
  ring: number;
  /** The client field, for `scope: "client"`. */
  clientId: string;
  /**
   * Whether an active client is in a ring past ring 0. Without one, the
   * form offers no scope: every client is in ring 0, so it reaches all.
   */
  pastFirstRing: boolean;
}

const scopeOf = ({
  scope,
  ring,
  clientId,
  pastFirstRing,
}: StartChoices): StartRolloutInput["scope"] => {
  if (!pastFirstRing || scope === "all") {
    return { scope: "all" };
  }
  if (scope === "client") {
    if (clientId === "") {
      throw new InvalidFieldError("Name the client to roll out to.");
    }
    return { scope: "client", clientId };
  }
  return { scope: "ring", ring };
};

/**
 * The rollout `choices` start, or why they can't be one
 * (`InvalidFieldError`, shown as it says).
 */
export const startRequestOf = (choices: StartChoices): StartRolloutInput => {
  const scope = scopeOf(choices);
  return choices.what === "secrets"
    ? { kind: "secrets", scope }
    : { kind: "release", releaseId: choices.releaseId, scope };
};
