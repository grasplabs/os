import type { AuditActor } from "@grasp-os/shared/audit";
import {
  appIdSchema,
  connectionIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import type { Authority } from "@grasp-os/shared/permissions";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { inList } from "./db/d1.ts";
import { collections, documents } from "./db/knowledge/schema.ts";
import { featureEnabled } from "./features.ts";
import { isRestricted } from "./restricted.ts";
import type { RestrictedEnv, WorkContext } from "./restricted.ts";

// The client's rules for model calls, which the gateway checks on every
// call before anything is sent (models.ts): beyond the allowlist, which
// always applies, whether a call must stay with a model hosted in the EU,
// and which models may take sensitive data.
//
// The rules are deployment config, part of the `MODEL_GATEWAY` var the
// console sets, like the allowlist: they are what the client agreed to, so
// no admin session can loosen them in the product. A config whose rules
// don't parse refuses every call while they apply (models.ts), and is
// never read while they don't.
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
//
// A call carries sensitive data when its context is in restricted mode
// (restricted.ts), which is sticky: once a chat or an App has read a
// sensitive collection, everything it sends a model may hold what it read.
// So does a call whose provenance names a sensitive collection, or one of
// its documents, or whose data came from a connection the config marks
// sensitive. Only the models the data rule lists may take such a call.

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
  sensitive: z
    .strictObject({
      /** The allowed models that may take sensitive data. */
      models: z.array(modelRef).min(1),
      /** Connections whose data is sensitive. */
      connections: z.array(connectionIdSchema).default([]),
    })
    .optional(),
});

export type ModelRules = z.output<
  z.ZodObject<ReturnType<typeof modelRulesShape>>
>;

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
  /** Where the call works, whose restricted mode it has. */
  work?: { authority: Authority; context: WorkContext };
}

/** Why a call must stay in the EU: which rule says so. */
export type EuOnly = "deployment" | "workflow" | "connection";

/** Why a call carries sensitive data. */
export type Sensitive = "restricted" | "collection" | "connection";

/** What the rules made of a call the gateway may send. */
export interface Judged {
  /** Why the call had to stay in the EU; `undefined` when it didn't. */
  euOnly: EuOnly | undefined;
  /**
   * Why the call carries sensitive data; `undefined` when it doesn't, or
   * when no data rule asked.
   */
  sensitive: Sensitive | undefined;
}

/** The connections whose data fed the prompt, or may have. */
const fedBy = ({ provenance, connections }: RulesInput): Set<string> =>
  new Set([...provenance, ...connections]);

const euOnlyBecause = (
  eu: NonNullable<ModelRules["eu"]>,
  input: RulesInput
): EuOnly | undefined => {
  const { trigger } = input;
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
  const fed = fedBy(input);
  return eu.connections.some((connection) => fed.has(connection))
    ? "connection"
    : undefined;
};

/**
 * Whether `ids` name a sensitive collection, or a document in one: one
 * query, whatever their number.
 */
const namesSensitiveCollection = async (
  env: Pick<Env, "KNOWLEDGE">,
  ids: readonly string[]
): Promise<boolean> => {
  if (ids.length === 0) {
    return false;
  }
  const db = drizzle(env.KNOWLEDGE);
  const found = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.sensitive, true),
        or(
          inList(collections.id, ids),
          inArray(
            collections.id,
            db
              .select({ id: documents.collectionId })
              .from(documents)
              .where(inList(documents.id, ids))
          )
        )
      )
    )
    .limit(1)
    .get();
  return found !== undefined;
};

/** Cheapest check first: the config, then Knowledge, then the context's object. */
const sensitiveBecause = async (
  env: RestrictedEnv & Pick<Env, "KNOWLEDGE">,
  sensitive: NonNullable<ModelRules["sensitive"]>,
  input: RulesInput
): Promise<Sensitive | undefined> => {
  const fed = fedBy(input);
  if (sensitive.connections.some((connection) => fed.has(connection))) {
    return "connection";
  }
  if (await namesSensitiveCollection(env, input.provenance)) {
    return "collection";
  }
  const { work } = input;
  if (
    work !== undefined &&
    (await isRestricted(env, work.authority, work.context))
  ) {
    return "restricted";
  }
  return undefined;
};

/** Why the gateway refused a call: the code, and which rule said so. */
export interface Refusal {
  code: "model.not_allowed" | "model.eu_only" | "model.sensitive_data";
  because?: string;
}

/**
 * Judges a call by the deployment's rules: what they made of it, or why
 * they refuse it. Throws `permission.context_invalid` for a `work` context
 * the call's authority can't work in.
 */
export const judgeCall = async (
  env: RestrictedEnv & Pick<Env, "FEATURES" | "KNOWLEDGE">,
  rules: ModelRules,
  input: RulesInput
): Promise<{ ok: true; judged: Judged } | ({ ok: false } & Refusal)> => {
  if (!featureEnabled(env, "model_rules")) {
    return { ok: true, judged: { euOnly: undefined, sensitive: undefined } };
  }
  const { eu, sensitive: dataRule } = rules;
  const euOnly = eu === undefined ? undefined : euOnlyBecause(eu, input);
  if (euOnly !== undefined && eu?.models.includes(input.model) !== true) {
    return { ok: false, code: "model.eu_only", because: euOnly };
  }
  const sensitive =
    dataRule === undefined
      ? undefined
      : await sensitiveBecause(env, dataRule, input);
  if (
    sensitive !== undefined &&
    dataRule?.models.includes(input.model) !== true
  ) {
    return { ok: false, code: "model.sensitive_data", because: sensitive };
  }
  return { ok: true, judged: { euOnly, sensitive } };
};
