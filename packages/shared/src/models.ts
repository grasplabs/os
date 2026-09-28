import { defineErrorFamily } from "./errors.ts";

/** Why the model gateway refused or failed a model call. */
export const modelErrors = defineErrorFamily({
  "model.invalid_call": "That isn't a valid model call.",
  "model.unconfigured": "Models aren't set up for this deployment yet.",
  "model.not_allowed": "This deployment doesn't allow that model.",
  "model.eu_only":
    "This call must stay in the EU, and that model isn't hosted in the EU. Choose one that is.",
  "model.sensitive_data":
    "This call carries sensitive data, and that model may not take it. Choose one this deployment allows for sensitive data.",
  "model.over_budget":
    "This month's model budget is used up, so no more model calls can be made for this. An admin can raise the budget.",
  "model.failed": "The model call failed. Try again later.",
  "model.invalid_output":
    "The model's answer didn't match the expected shape, also when asked again.",
});

/** Whose spend a budget counts: all calls, each workflow's, each person's. */
export type ModelBudgetScope = "deployment" | "workflow" | "user";

/** What spent part of a budget this month, with its name where core has one. */
export type ModelSpender =
  | { type: "deployment" }
  | {
      type: "workflow";
      appId: string;
      /** Null once the App is gone. */
      appName: string | null;
      workflowId: string;
    }
  | {
      type: "user";
      userId: string;
      /** Null once the person is gone. */
      name: string | null;
    };

/** Most workflows or people one budget lists the spend of. */
export const modelSpendListed = 50;

/** One budget the deployment sets, and what it counted this month. */
export interface ModelBudget {
  scope: ModelBudgetScope;
  /**
   * US dollars a month: for the deployment, all its calls together; for a
   * workflow or a person, each one on its own.
   */
  limit: number;
  /** The percent of the limit at which admins are alerted. */
  alertAt: number;
  /**
   * This month's spend in US dollars, most first: the deployment's, or
   * that of each workflow or person that spent, at most
   * {@link modelSpendListed} of them. Empty while nothing was spent.
   */
  spent: { of: ModelSpender; amount: number }[];
}

/** The client's rules beyond the allowlist, while they apply. */
export interface ModelRulesSettings {
  /** Which calls must stay with a model hosted in the EU; null for none. */
  eu: {
    /** The allowed models hosted in the EU. */
    models: string[];
    /** Every call of the deployment. */
    deployment: boolean;
    /** Workflows whose AI steps must stay in the EU. */
    workflows: { app: string; workflow: string }[];
    /** Connections whose data must stay in the EU. */
    connections: string[];
  } | null;
  /**
   * Which models may take sensitive data: from a sensitive collection
   * (marked in Knowledge), from a connection listed here, or in a chat, App
   * or run that read either. Null for no data rule.
   */
  sensitive: { models: string[]; connections: string[] } | null;
  budgets: ModelBudget[];
}

/**
 * The model gateway's settings, as admins read them. They are deployment
 * config that Grasp sets for the client, so nobody changes them in the
 * product.
 */
export interface ModelSettings {
  /**
   * The models the deployment allows, as `<provider>/<model>`. Empty while
   * models aren't set up: every call is refused then.
   */
  models: string[];
  /**
   * The client's other rules: `off` while switched off, and only the
   * allowlist applies; `invalid` when they don't parse, and every call is
   * refused.
   */
  rules:
    | { state: "off" }
    | { state: "invalid" }
    | ({ state: "on" } & ModelRulesSettings);
  /** The UTC month budgets count in now, such as `2026-09`. */
  month: string;
}

/** The model gateway's settings, over `/rpc`, for admins only. */
export interface ModelsApi {
  /** The settings, and this month's spend against each budget. */
  settings: () => Promise<ModelSettings>;
}
