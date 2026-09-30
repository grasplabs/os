import { z } from "zod";

import { isExportName } from "./apps.ts";
import type { AgentProposer } from "./apps.ts";
import { defineErrorFamily } from "./errors.ts";
import {
  agentIdSchema,
  appIdSchema,
  chatIdSchema,
  collectionIdSchema,
  connectionIdSchema,
  identifierMaxLength,
  identifierSchema,
  runIdSchema,
  workflowIdSchema,
  workspaceIdSchema,
} from "./ids.ts";
import type { AppId, PermissionId } from "./ids.ts";

// Apps and agents start with nothing. Each thing they may use is one
// permission: a person asks for it, an admin grants it (their own request
// included), and every call checks it again on the server.
// Everything here names things by ID and stays identifier-sized, because
// each grant and revoke goes into the audit log with these values.

/** Who a permission is for: an App, or an agent. Never a person. */
export const permissionSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("app"),
    appId: appIdSchema,
  }),
  z.strictObject({
    type: z.literal("agent"),
    agentId: agentIdSchema,
  }),
]);
export type PermissionSubject = z.infer<typeof permissionSubjectSchema>;
/** A subject as a client sends it, with a plain string ID. */
export type PermissionSubjectInput = z.input<typeof permissionSubjectSchema>;

/**
 * A field of a connection's results, by name, such as `body`: a permission
 * that masks it gets every field of that name its native connector's tools
 * declare maskable back as `null`. A call connect can't mask for (a
 * remote server's, or with a field no tool of the connector declares) is
 * refused.
 */
export const maskFieldSchema = z.string().regex(/^[A-Za-z]\w{0,63}$/u);

/** Most fields one permission masks. */
export const permissionMaxMaskFields = 16;

/** The fields a permission masks, each once. */
export const maskFieldsSchema = z
  .array(maskFieldSchema)
  .max(permissionMaxMaskFields)
  .refine((fields) => new Set(fields).size === fields.length, {
    message: "Each field once",
  });

/** A Knowledge collection, as a permission's object. */
const collectionObjectSchema = z.strictObject({
  type: z.literal("collection"),
  collectionId: collectionIdSchema,
});

/**
 * What the platform itself offers an App, as a permission's object, one
 * action per permission (its stub does that one thing):
 *
 * - `statistics`: the measures the platform publishes of Apps' runs
 *   (`platformMeasures` in `@grasp-os/shared/statistics`), which an App
 *   reads only once an admin grants it this, and then only of Apps whose
 *   runs the person it acts for may see. An App's own statistics need no
 *   permission.
 * - `guests`: inviting people who aren't members to a short chat with a
 *   model, through a link, and reading back what they wrote
 *   (`@grasp-os/shared/guests`).
 */
const platformObjectSchema = z.strictObject({ type: z.literal("platform") });

/**
 * What a permission gives access to: a connection (all of it, or one
 * resource in it, such as one mailbox), a Knowledge collection, one
 * workflow of an App, another App's exports: the methods of its server
 * code it lets other Apps call (`appExportsPath`), or the platform's own
 * statistics.
 */
export const permissionObjectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("connection"),
    connectionId: connectionIdSchema,
    /** One resource in the connection; absent means the whole connection. */
    resource: identifierSchema.optional(),
    /**
     * Fields of its results masked for this permission, such as `body`
     * and `content` for one that may see metadata only.
     */
    mask: maskFieldsSchema.min(1).optional(),
  }),
  collectionObjectSchema,
  z.strictObject({
    type: z.literal("workflow"),
    appId: appIdSchema,
    workflowId: workflowIdSchema,
  }),
  z.strictObject({
    type: z.literal("app"),
    appId: appIdSchema,
  }),
  platformObjectSchema,
]);
export type PermissionObject = z.infer<typeof permissionObjectSchema>;
export type PermissionObjectType = PermissionObject["type"];

/**
 * A connection's actions are its connector's tool names (native ones such
 * as `mail.send`, or a catalog's such as `GMAIL_SEND_EMAIL`); which of them
 * write is the connector's to say, in connect.
 */
const connectionActionPattern = /^[A-Za-z][\w.-]{0,63}$/u;

/** The actions of collections and workflows, fixed by the platform. */
const platformActions = {
  collection: ["read", "write"],
  workflow: ["read", "start"],
  platform: ["statistics", "guests"],
} as const;

/**
 * What a platform permission's one action is: each is a binding of its
 * own kind in an App's env (statistics, guest chats).
 */
export const platformActionSchema = z.enum(platformActions.platform);
export type PlatformAction = z.infer<typeof platformActionSchema>;

/** One action a permission allows. */
export const permissionActionSchema = z.string().regex(connectionActionPattern);

/** Whether `action` is one an object of `type` has. */
const isActionOf = (type: PermissionObjectType, action: string): boolean => {
  if (type === "connection") {
    return connectionActionPattern.test(action);
  }
  // Another App's exports: all those it marks `read`, all those it marks
  // `write`, or one by its name, whichever it is marked.
  if (type === "app") {
    return action === "read" || action === "write" || isExportName(action);
  }
  const actions: readonly string[] = platformActions[type];
  return actions.includes(action);
};

/** Most actions one permission lists. */
export const permissionMaxActions = 16;

/**
 * The names of core's and connect's own bindings, secrets and vars. A
 * permission can't use one, so a stub is never mistaken for, or passed off
 * as, a platform binding. Tests check this list against both Workers' env.
 */
const platformBindingNames: ReadonlySet<string> = new Set([
  "AI",
  // A workflow run's own App (its server methods), next to its permissions.
  "APP",
  "APP_CALL_TIMEOUT_MS",
  "APPS",
  "ASSETS",
  "AUDIT_ARCHIVE",
  "AUDIT_ARCHIVE_RETENTION_DAYS",
  "AUDIT_LOG",
  "AUDIT_RETENTION_DAYS",
  "BETTER_AUTH_SECRET",
  "BUILTINS",
  "CAPABILITY_SIGNING_KEY",
  "CAPABILITY_SIGNING_KEY_PREVIOUS",
  "CF_VERSION_METADATA",
  "COMPOSIO_API_KEY",
  "CONNECT",
  "DB",
  "DEV_SKIP_ROUTER_SECRET",
  "DURABLE_OBJECT_JURISDICTION",
  "EMAIL",
  "FEATURES",
  "ENTRA_CLIENT_SECRET",
  "FILES",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "KNOWLEDGE",
  "LOADER",
  "MEMORY_LIMITS",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MODEL_GATEWAY",
  "PLATFORM_CHANGE",
  "ROUTER_SECRET",
  "ROUTER_SECRET_PREVIOUS",
  "RUN_RETENTION_DAYS",
  "SIGN_IN",
  // An App's statistics (core's src/statistics.ts), next to its permissions.
  "STATISTICS",
  "STATISTICS_POINT_LIMITS",
  "STATISTICS_READ_LIMITS",
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_ENCRYPTION_KEY_PREVIOUS",
  "WORKFLOW_OFF_WAIT_MS",
  "WORKFLOW_STEP_LIMIT",
  "WORKFLOWS",
  "WORKSPACES",
]);

/**
 * The name a permission's stub has in the env of the App or agent, such as
 * `OUTLOOK`. Upper case only, like every other binding: that also keeps out
 * `__proto__`, `constructor` and every other name an object already has.
 */
export const bindingNameSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/u, "Upper case letters, digits and _")
  .refine((name) => !platformBindingNames.has(name), {
    message: "A name the platform uses itself",
  });

/** What a permission gives: the object, its actions and the stub's name. */
const grantShape = {
  object: permissionObjectSchema,
  actions: z
    .array(permissionActionSchema)
    .min(1)
    .max(permissionMaxActions)
    .refine((actions) => new Set(actions).size === actions.length, {
      message: "Each action once",
    }),
  binding: bindingNameSchema,
};

/**
 * Refuses an action the object doesn't have, and actions or masked fields
 * too long for the audit log.
 */
const checkGrant = (
  { object, actions }: { object: PermissionObject; actions: readonly string[] },
  context: z.RefinementCtx
): void => {
  for (const action of actions) {
    if (!isActionOf(object.type, action)) {
      context.addIssue({
        code: "custom",
        path: ["actions"],
        message: `A ${object.type} has no action ${action}`,
      });
    }
  }
  // A platform permission's stub does one thing: the action names it.
  if (object.type === "platform" && actions.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["actions"],
      message: "A platform permission has one action",
    });
  }
  // The audit log records the actions as one identifier-sized value.
  if (actions.join(" ").length > identifierMaxLength) {
    context.addIssue({
      code: "custom",
      path: ["actions"],
      message: "Too many actions for one permission",
    });
  }
  // And the masked fields too.
  const mask = object.type === "connection" ? (object.mask ?? []) : [];
  if (mask.join(" ").length > identifierMaxLength) {
    context.addIssue({
      code: "custom",
      path: ["object", "mask"],
      message: "Too many masked fields for one permission",
    });
  }
};

/** What a person asks for: the subject, the object, its actions, the name. */
export const permissionRequestSchema = z
  .strictObject({ subject: permissionSubjectSchema, ...grantShape })
  .superRefine(checkGrant);
/** A permission request as a client sends it, with plain string IDs. */
export type PermissionRequest = z.input<typeof permissionRequestSchema>;

/**
 * A permission a built-in blueprint declares (its `blueprint.json`): a
 * request without its subject, which is every App created from it. Only
 * a collection one of its blueprints declares (`declaredCollectionSchema`
 * in `@grasp-os/shared/knowledge`), or what the platform offers (its
 * statistics, guest chats): the things a built-in can name the same way
 * in every deployment, where
 * connections have IDs of their own in each.
 */
export const declaredPermissionSchema = z
  .strictObject({
    ...grantShape,
    object: z.discriminatedUnion("type", [
      collectionObjectSchema,
      platformObjectSchema,
    ]),
  })
  .superRefine(checkGrant);
export type DeclaredPermission = z.infer<typeof declaredPermissionSchema>;

/**
 * Requested: asked for, allows nothing yet. Active: granted, allows its
 * actions. Revoked: allows nothing, for good (ask again for a new one).
 * An App's active permission on a connection, to write a collection, to
 * start a workflow, or to call another App's exports other than all those
 * marked `read`, goes back to requested when someone who couldn't grant
 * it (Grasp staff included) makes another version of the App current
 * (`AppVersionsApi.setCurrent`), until an admin grants it again.
 */
export const permissionStatusSchema = z.enum([
  "requested",
  "active",
  "revoked",
]);
export type PermissionStatus = z.infer<typeof permissionStatusSchema>;

/**
 * What an admin reviewed as they grant a permission: the version of its
 * App current then, or null for an agent's, or an App with none current.
 */
export const grantReviewSchema = z.strictObject({
  version: z.int().positive().nullable(),
});
export type GrantReview = z.infer<typeof grantReviewSchema>;

/** One permission, as the API returns it. */
export interface Permission {
  id: PermissionId;
  subject: PermissionSubject;
  object: PermissionObject;
  actions: string[];
  binding: string;
  status: PermissionStatus;
  /** User IDs, and when (ISO 8601). */
  requestedBy: string;
  requestedAt: string;
  /**
   * Who granted it last, and when. On a requested permission, it was
   * granted before and is asked for again (`AppVersionsApi.setCurrent`);
   * only `status` says what it allows.
   */
  grantedBy: string | null;
  grantedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  /**
   * The chat's agent that asked for it, acting for `requestedBy`; null
   * when that person asked themselves.
   */
  requestedVia: AgentProposer | null;
  /**
   * On an App's request to write a collection: the record types the
   * version of it current now declares there (`@grasp-os/shared/apps`),
   * those it would claim once granted, and those another App has there
   * already, which it would not get: that App is named to admins only.
   * None otherwise.
   */
  recordTypes?: {
    claims: string[];
    taken: { type: string; owner: AppId | null }[];
  };
}

/**
 * A signed-in person's permissions, over `/rpc`: every call checks the
 * session and the person's role again.
 */
export interface PermissionsApi {
  /**
   * Asks for a permission for an App or agent; it allows nothing until an
   * admin grants it. Admins and builders; for an App, only its builders.
   */
  request: (request: PermissionRequest) => Promise<Permission>;
  /**
   * Grants a requested permission, the admin's own request included.
   * Admins only, never Grasp staff; audited. Refused for a built-in
   * blueprint's own permissions (`permission.builtin`): they are granted on
   * the Apps created from it. `reviewed.version` is the version of the App
   * the admin reviewed, the one current as they decided (null for an
   * agent's permission, or an App with none current): the grant approves
   * it, and is refused with `app.conflict`, changing nothing, once another
   * version is current.
   */
  grant: (id: string, reviewed: GrantReview) => Promise<Permission>;
  /**
   * Revokes a permission; the next call that needs it is refused. Admins
   * only, never Grasp staff; audited. Refused for a built-in blueprint's
   * own permissions (`permission.builtin`), which only a release changes.
   */
  revoke: (id: string) => Promise<Permission>;
  /**
   * Every permission, or one App's or agent's, oldest first; only those in
   * `status` when given. Admins and builders.
   */
  list: (
    subject?: PermissionSubjectInput,
    status?: PermissionStatus
  ) => Promise<Permission[]>;
}

/**
 * How a call reaches for access: which App or agent makes it, the person it
 * acts for, and whether a person is there (interactive) or a workflow runs
 * on its own. The host sets it, from the session or the run; never the code
 * that makes the call.
 *
 * A workflow run acts for the person who started it, or for the workflow's
 * owner when a trigger or schedule started it, and stops when that person
 * leaves. The permission check only requires that the person is still a
 * member; it doesn't intersect the grant with the person's own access. That
 * part of "never more than the person" (R5) is enforced where the access
 * lives: connect limits personal connections to their owner, and the
 * Knowledge queries limit collections to what the person may read.
 */
export const authoritySchema = z
  .strictObject({
    subject: permissionSubjectSchema,
    onBehalfOf: identifierSchema,
    mode: z.enum(["interactive", "workflow"]),
    /**
     * For a call from an App's code: the App version whose code made it,
     * set by the host. Required for an App, and it decides access: a
     * version no admin approved changes nothing (core's `authorize`). The
     * audit log traces each call to the code that made it (threat model
     * SB9). An agent has none.
     */
    appVersion: z.int().positive().optional(),
  })
  .refine(
    ({ subject, appVersion }) =>
      (subject.type === "app") === (appVersion !== undefined),
    {
      path: ["appVersion"],
      message: "An App's call names its version; an agent's none",
    }
  );
export type Authority = z.infer<typeof authoritySchema>;

/**
 * Where an App or agent works, and keeps its restricted mode: a chat, an
 * App, or a run of one of the App's workflows. The host sets it, like the
 * authority.
 */
export const workContextSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("chat"),
    workspaceId: workspaceIdSchema,
    chatId: chatIdSchema,
  }),
  z.strictObject({ type: z.literal("app"), appId: appIdSchema }),
  z.strictObject({
    type: z.literal("run"),
    appId: appIdSchema,
    runId: runIdSchema,
  }),
]);
export type WorkContext = z.infer<typeof workContextSchema>;

/** Why a permission call was refused. */
export const permissionErrors = defineErrorFamily({
  "permission.denied": "This App or agent has no permission to do that.",
  "permission.context_invalid":
    "This App or agent can't work in that chat or App, or it doesn't exist.",
  "permission.restricted":
    "This chat, App or run has read restricted data, so it can no longer act on or fetch from outside systems.",
  "permission.person_inactive":
    "The person this acts for no longer has access to this deployment.",
  "permission.invalid": "That isn't a valid permission request.",
  "permission.not_found": "There's no such permission.",
  "permission.not_requested": "Only a requested permission can be granted.",
  "permission.conflict":
    "This App or agent already has a permission with that binding name.",
  "permission.builtin":
    "A built-in blueprint's permissions are what the Apps created from it ask for: grant or revoke them on those Apps.",
});
