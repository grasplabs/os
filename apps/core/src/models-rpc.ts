import type { ModelSettings, ModelsApi } from "@grasp-os/shared/models";
import { requireAdmin } from "@grasp-os/shared/roles";
import { RpcTarget } from "capnweb";

import { budgetMonth, budgetSpend } from "./model-budgets.ts";
import { gatewaySettings } from "./models.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// The model gateway's settings, for admins to read: the allowlist and the
// client's rules (models.ts, model-rules.ts), and this month's spend
// against each budget (model-budgets.ts). The settings are deployment
// config that the console sets, so nothing here changes them. Reads aren't
// audited: the rules are the console's to record, and each call's cost is
// in the audit log already, with its model call.

/** The gateway's settings over `/rpc`, for admins, Grasp staff included. */
export class ModelsRpc extends RpcTarget implements ModelsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async settings(): Promise<ModelSettings> {
    return await withPerson(this.#check, async (person) => {
      requireAdmin(person);
      const { models, rules } = gatewaySettings(this.#env);
      const month = budgetMonth(this.#env);
      if (rules === undefined) {
        return { models, rules: { state: "invalid" }, month };
      }
      return {
        models,
        rules: {
          state: "on",
          eu: rules.eu ?? null,
          sensitive: rules.sensitive ?? null,
          budgets: await budgetSpend(this.#env, rules.budgets, month),
        },
        month,
      };
    });
  }
}
