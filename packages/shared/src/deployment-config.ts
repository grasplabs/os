import { z } from "zod";

import { appIdSchema, connectionIdSchema, workflowIdSchema } from "./ids.ts";
import { roleSchema } from "./roles.ts";
import { loopbackHosts } from "./router.ts";

// The deployment config vars the console sets on core, as core parses them
// (with `deploymentConfig`, @grasp-os/shared/config) and the console
// validates them before it deploys: one schema for both, so the console
// never sets a value core would refuse. Each var is deployment config,
// never an in-product setting, so no admin session can change it. The
// `MEMORY_LIMITS` var's schema is `memoryLimitsSchema` in
// @grasp-os/shared/memory, and `PLATFORM_CHANGE`'s is in
// @grasp-os/shared/platform-change.

// SIGN_IN (core's src/auth/config.ts)

const domainSchema = z
  .string()
  .regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u, "a lowercase domain, e.g. acme.com");

/** An HTTPS origin, or plain HTTP on this machine for local development. */
const isOrigin = (value: string): boolean => {
  if (!URL.canParse(value)) {
    return false;
  }
  const url = new URL(value);
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackHosts.has(url.hostname));
  return secure && url.origin === value;
};

/**
 * How people sign in to a deployment: the `SIGN_IN` var. A compromised
 * admin session can't add a tenant, widen the domains or open staff
 * access. Without it nobody can sign in.
 */
export const signInConfigSchema = z.object({
  /**
   * The deployment's own address, e.g. `https://acme.<domain>`: where the
   * IdPs send people back, and the only page that may open `/rpc`.
   */
  origin: z.url().refine(isOrigin, "an https origin, without a path"),
  /** Email domains people may sign in with, exactly (no subdomains). */
  domains: z.array(domainSchema).min(1),
  /** Emails that get the admin role when they join. */
  admins: z.array(z.email().toLowerCase()).default([]),
  /*
   * A deployment may offer both IdPs, but a person is one account at one of
   * them: an email already signed in through one is refused through the
   * other, as accounts are never linked by email (threat model R15).
   */
  /** The client's Microsoft Entra tenant, pinned. */
  entra: z
    .object({ tenantId: z.guid(), clientId: z.string().min(1) })
    .optional(),
  /** The client's Google Workspace, pinned by its primary domain (`hd`). */
  google: z
    .object({ hostedDomain: domainSchema, clientId: z.string().min(1) })
    .optional(),
  /**
   * Grasp staff access, off unless the console opens a window. Only the
   * listed people (Entra object ids in Grasp's own tenant) sign in, get
   * `role` without joining the organization, and lose access when `until`
   * passes. A window longer than {@link staffWindowMaxMs} is closed
   * (`staffWindowOpen`).
   */
  staff: z
    .object({
      tenantId: z.guid(),
      clientId: z.string().min(1),
      domains: z.array(domainSchema).min(1),
      oids: z.array(z.guid()).min(1),
      role: roleSchema,
      /** When the console opened the window. */
      opened: z.iso.datetime({ offset: true }),
      until: z.iso.datetime({ offset: true }),
    })
    .optional(),
});
export type SignInConfig = z.infer<typeof signInConfigSchema>;

/**
 * The domain of `email`, as core's sign-in reads it (core's
 * src/auth/claims.ts): after the last `@`, lowercase.
 */
const emailDomainOf = (email: string): string | undefined => {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : undefined;
};

/**
 * The admins of `config` who can never sign in: core signs in only people
 * whose email is in one of its `domains`, whichever IdP they come from.
 */
export const unreachableAdmins = ({
  domains,
  admins,
}: {
  domains: readonly string[];
  admins: readonly string[];
}): string[] =>
  admins.filter((email) => {
    const domain = emailDomainOf(email);
    return domain === undefined || !domains.includes(domain);
  });

/** The longest a staff window may be. */
export const staffWindowMaxMs = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether the staff window is open at `now`: between `opened` and `until`,
 * and seven days long at most. A longer window counts as closed for its
 * whole length, never only once its end draws near: the console opens short
 * windows, and a longer one is a mistake rather than a reason to let staff
 * in.
 */
export const staffWindowOpen = (
  config: SignInConfig | undefined,
  now: number
): boolean => {
  if (config?.staff === undefined) {
    return false;
  }
  const opened = Date.parse(config.staff.opened);
  const until = Date.parse(config.staff.until);
  return opened <= now && now < until && until - opened <= staffWindowMaxMs;
};

// FEATURES (core's src/features.ts)

/**
 * Feature flags: the `FEATURES` var, e.g. `{"apps": true}`. A feature it
 * doesn't name is off. Names nobody knows (a flag since removed) are
 * ignored, not an error.
 */
export const featuresSchema = z.record(z.string(), z.boolean());

// MODEL_GATEWAY (core's src/models.ts and src/model-rules.ts)
//
// Its model references are checked against the models the gateway offers,
// which only core knows (its provider catalogs): each schema here takes
// that check as `modelRef`.

/** An AI Gateway ID: lowercase letters, digits and dashes. */
const gatewayIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/**
 * The allowlist's part of the `MODEL_GATEWAY` var: the deployment's AI
 * Gateway and the models it allows. `modelRef` checks one
 * `<provider>/<model>` the gateway offers.
 */
export const modelGatewayConfigSchema = (modelRef: z.ZodType<string>) =>
  z.object({
    /** The deployment's AI Gateway, in the deployment's own account. */
    gateway: z.string().regex(gatewayIdPattern),
    /** The models this deployment allows; every other model is refused. */
    models: z.array(modelRef).min(1),
  });

/**
 * The models a new deployment allows until staff set its `MODEL_GATEWAY`:
 * Workers AI's, which AI Gateway runs on the client's own account with no
 * provider key, so a client can call a model on day one.
 */
export const defaultGatewayModels = [
  "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
] as const;

const budgetSchema = z.strictObject({
  /** US dollars a month: a cent at least, and well within an integer. */
  limit: z.number().min(0.01).max(1_000_000_000),
  /** The percent of the limit at which admins are alerted. */
  alertAt: z.int().min(1).max(99).default(80),
});

/** The budgets' part of the gateway config (core's src/model-budgets.ts). */
export const budgetsSchema = z
  .strictObject({
    /** All the deployment's calls together. */
    deployment: budgetSchema.optional(),
    /** Each workflow's AI steps, each workflow on its own. */
    workflow: budgetSchema.optional(),
    /** The calls made by or for each person, each on their own. */
    user: budgetSchema.optional(),
  })
  .optional();

/**
 * The rules' part of the gateway config: `modelRef` checks one
 * `<provider>/<model>` the gateway offers.
 */
const modelRulesShape = (modelRef: z.ZodType<string>) => ({
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
  budgets: budgetsSchema,
});

export type ModelRules = z.output<
  z.ZodObject<ReturnType<typeof modelRulesShape>>
>;

/**
 * The client's other rules, in the same var as the allowlist. Core parses
 * them apart from it, and only while `model_rules` is on: so a rule that
 * doesn't parse never stops the calls the kill switch leaves to the
 * allowlist, and while the rules are on, it refuses every call.
 */
export const modelRulesConfigSchema = (modelRef: z.ZodType<string>) =>
  z
    .object({
      models: z.array(z.string()),
      ...modelRulesShape(modelRef),
    })
    .refine(
      ({ models: allowed, eu }) =>
        eu === undefined || eu.models.every((ref) => allowed.includes(ref)),
      { message: "EU models are allowed models", path: ["eu", "models"] }
    )
    .refine(
      ({ models: allowed, sensitive }) =>
        sensitive === undefined ||
        sensitive.models.every((ref) => allowed.includes(ref)),
      {
        message: "Models for sensitive data are allowed models",
        path: ["sensitive", "models"],
      }
    );

// AUDIT_RETENTION_DAYS and AUDIT_ARCHIVE_RETENTION_DAYS (core's
// src/audit-log.ts)

/** Days the audit log keeps an event where admins search it, unless set. */
export const auditRetentionDefaultDays = 180;

/**
 * `AUDIT_RETENTION_DAYS`: at least 30 days (so an admin always has the
 * last month to search), at most ten years.
 */
export const auditRetentionSchema = z.int().min(30).max(3650);

/**
 * `AUDIT_ARCHIVE_RETENTION_DAYS`: how long archived stretches are kept, in
 * days from when the log received their last event: at least a year, at
 * most ten. Core also refuses one shorter than the retention.
 */
export const auditArchiveRetentionSchema = z.int().min(365).max(3650);

/**
 * The names of the deployment config vars above, the only settings the
 * console sets on core as vars. `PLATFORM_CHANGE` is the console's own, set
 * on every version it deploys, never a setting.
 */
export const deploymentConfigVars = [
  "SIGN_IN",
  "FEATURES",
  "MODEL_GATEWAY",
  "MEMORY_LIMITS",
  "AUDIT_RETENTION_DAYS",
  "AUDIT_ARCHIVE_RETENTION_DAYS",
] as const;
