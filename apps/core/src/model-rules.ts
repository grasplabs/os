import type { AuditActor } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  connectionIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { z } from "zod";

import { featureEnabled } from "./features.ts";

// The client's rules for model calls, which the gateway checks on every
// call before anything is sent (models.ts): beyond the allowlist, which
// always applies, whether a call must stay with a model hosted in the EU.
//
// The rules are deployment config, part of the `MODEL_GATEWAY` var the
// console sets, like the allowlist: they are what the client agreed to, so
// no admin session can loosen them in the product. A config whose rules
// don't parse counts as none, and every call is refused (models.ts).
//
// They apply while `model_rules` is on; switching it off is the kill
// switch, which leaves only the allowlist.
//
// "Hosted in the EU" is the config's word for a model: the client's
// provider serves it in the EU (its EU data residency, with the keys AI
// Gateway stores for it). Every call, one that must stay in the EU too,
// still goes through AI Gateway, which can't be pinned to the EU: it passes
// the request on and logs its metadata only (models.ts). A direct EU route
// comes later, through connect.

/**
 * The rules' part of the gateway config: `modelRef` checks one
 * `<provider>/<model>` the gateway offers.
 */
export const modelRulesShape = (modelRef: z.ZodType<string>) => ({
  eu: z
    .strictObject({
      /** The allowed models hosted in the EU. */
      models: z.array(modelRef).min(1),
      /** Every call of the deployment must stay in the EU. */
      deployment: z.boolean().default(false),
      /** Workflows whose AI steps must stay in the EU. */
      workflows: z
        .array(z.strictObject({ app: appIdSchema, workflow: workflowIdSchema }))
        .default([]),
      /** Connections whose data must stay in the EU. */
      connections: z.array(connectionIdSchema).default([]),
    })
    .optional(),
});

type ModelRules = z.output<z.ZodObject<ReturnType<typeof modelRulesShape>>>;

/** What the rules judge a call by. */
export interface RulesInput {
  /** `<provider>/<model>`, one the deployment allows. */
  model: string;
  /** Who or what asked. */
  trigger: AuditActor;
  /** IDs of the resources that fed the prompt. */
  provenance: readonly string[];
  /** Connections whose data may have fed the prompt. */
  connections: readonly string[];
}

/** Why a call must stay in the EU: which rule says so. */
export type EuOnly = "deployment" | "workflow" | "connection";

/** What the rules made of a call the gateway may send. */
export interface Judged {
  /** Why the call had to stay in the EU; `undefined` when it didn't. */
  euOnly: EuOnly | undefined;
}

const euOnlyBecause = (
  eu: NonNullable<ModelRules["eu"]>,
  { trigger, provenance, connections }: RulesInput
): EuOnly | undefined => {
  if (eu.deployment) {
    return "deployment";
  }
  if (
    trigger.type === "workflow" &&
    eu.workflows.some(
      ({ app, workflow }) =>
        app === trigger.appId && workflow === trigger.workflowId
    )
  ) {
    return "workflow";
  }
  // A connection's data fed the prompt when it is named as provenance, or
  // may have when the caller had the connection at hand.
  const fedBy = new Set([...provenance, ...connections]);
  return eu.connections.some((connection) => fedBy.has(connection))
    ? "connection"
    : undefined;
};

/** Why the gateway refused a call: the code, and which rule said so. */
export interface Refusal {
  code: "model.not_allowed" | "model.eu_only";
  because?: string;
}

/**
 * Judges a call by the deployment's rules: what they made of it, or why
 * they refuse it.
 */
export const judgeCall = (
  env: Pick<Env, "FEATURES">,
  rules: ModelRules,
  input: RulesInput
): { ok: true; judged: Judged } | ({ ok: false } & Refusal) => {
  if (!featureEnabled(env, "model_rules") || rules.eu === undefined) {
    return { ok: true, judged: { euOnly: undefined } };
  }
  const euOnly = euOnlyBecause(rules.eu, input);
  if (euOnly !== undefined && !rules.eu.models.includes(input.model)) {
    return { ok: false, code: "model.eu_only", because: euOnly };
  }
  return { ok: true, judged: { euOnly } };
};
