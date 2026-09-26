import type {
  DecisionAnswerInput,
  DecisionsApi,
  DecisionView,
} from "@grasp-os/shared/decisions";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { answerDecision, decisionFor } from "./decisions.ts";

/**
 * A signed-in person's `decisions`: for screens and the decision's page. Every call checks the session (and the flags) first and hands the
 * identity that check returned, with its role and teams read now, to the
 * decision functions, which check that person may answer.
 */
export class DecisionsRpc extends RpcTarget implements DecisionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async get(decision: string): Promise<DecisionView> {
    return await withPerson(
      this.#check,
      async (by) => await decisionFor(this.#env, by, decision)
    );
  }

  async answer(
    decision: string,
    answer: DecisionAnswerInput
  ): Promise<DecisionView> {
    return await withPerson(
      this.#check,
      async (by) => await answerDecision(this.#env, by, decision, answer)
    );
  }
}
