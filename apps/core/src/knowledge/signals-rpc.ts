import type {
  KnowledgeSignals,
  KnowledgeSignalsApi,
} from "@grasp-os/shared/knowledge-signals";
import { RpcTarget } from "capnweb";

import { withPerson } from "../session-check.ts";
import type { SessionCheck } from "../session-check.ts";
import { dismissKnowledgeSignal, listKnowledgeSignals } from "./signals.ts";

/**
 * Knowledge usage signals for a signed-in person over `/rpc`, as
 * `KnowledgeRpc` is: the owner of the collections they are about lists
 * and dismisses them.
 */
export class KnowledgeSignalsRpc
  extends RpcTarget
  implements KnowledgeSignalsApi
{
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async list(): Promise<KnowledgeSignals> {
    return await withPerson(
      this.#check,
      async (person) => await listKnowledgeSignals(this.#env, person)
    );
  }

  async dismiss(signalId: string): Promise<void> {
    await withPerson(this.#check, async (person) => {
      await dismissKnowledgeSignal(this.#env, person, signalId);
    });
  }
}
