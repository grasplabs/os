import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";
import {
  agentIdSchema,
  appIdSchema,
  collectionIdSchema,
  connectionIdSchema,
  identifierMaxLength,
  identifierSchema,
  workflowIdSchema,
} from "./ids.ts";
import type { PermissionId } from "./ids.ts";

// Apps and agents start with nothing. Each thing they may use is one
// permission: a person asks for it, an admin grants it, and every call
// checks it again on the server. Everything here names things by ID and
// stays identifier-sized, because each grant and revoke goes into the audit
// log with these values.

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
 * that masks it gets every field of that name its connector's tools
 * declare maskable back as `null`.
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

/**
 * What a permission gives access to: a connection (all of it, or one
 * resource in it, such as one mailbox), a Knowledge collection, or one
 * workflow of an App.
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
  z.strictObject({
    type: z.literal("collection"),
    collectionId: collectionIdSchema,
  }),
  z.strictObject({
    type: z.literal("workflow"),
    appId: appIdSchema,
    workflowId: workflowIdSchema,
  }),
]);
export type PermissionObject = z.infer<typeof permissionObjectSchema>;
export type PermissionObjectType = PermissionObject["type"];

/**
 * A connection's actions are its connector's tool names (native ones such
 * as `mail.send`, or a catalog's such as `GMAIL_SEND_EMAIL`); which of them
 * write is the connector's to say, in connect.
 */
const connectionActionPattern = /^[A-Za-z][\w.-]{0,63}$/u;

/** The actions of the other objects, fixed by the platform. */
export const platformActions = {
  collection: ["read", "write"],
  workflow: ["read", "start"],
} as const;

/** One action a permission allows. */
export const permissionActionSchema = z.string().regex(connectionActionPattern);

/** Whether `action` is one an object of `type` has. */
export const isActionOf = (
  type: PermissionObjectType,
  action: string
): boolean => {
  if (type === "connection") {
    return connectionActionPattern.test(action);
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
export const platformBindingNames: ReadonlySet<string> = new Set([
  "AI",
  // A workflow run's own App (its server methods), next to its permissions.
  "APP",
  "APP_CALL_TIMEOUT_MS",
  "APPS",
  "ASSETS",
  "AUDIT_DLQ",
  "AUDIT_LOG",
  "AUDIT_QUEUE",
  "BETTER_AUTH_SECRET",
  "CAPABILITY_SIGNING_KEY",
  "CAPABILITY_SIGNING_KEY_PREVIOUS",
  "COMPOSIO_API_KEY",
  "CONNECT",
  "DB",
  "DEV_SKIP_ROUTER_SECRET",
  "DOWNLOAD_HOSTS",
  "DURABLE_OBJECT_JURISDICTION",
  "EMAIL",
  "FEATURES",
  "ENTRA_CLIENT_SECRET",
  "FILES",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "KNOWLEDGE",
  "LOADER",
  "MICROSOFT_CLIENT_ID",
  "MICROSOFT_CLIENT_SECRET",
  "MODEL_GATEWAY",
  "ROUTER_SECRET",
  "SIGN_IN",
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_ENCRYPTION_KEY_PREVIOUS",
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

/** What a person asks for: the subject, the object, its actions, the name. */
export const permissionRequestSchema = z
  .strictObject({
    subject: permissionSubjectSchema,
    object: permissionObjectSchema,
    actions: z
      .array(permissionActionSchema)
      .min(1)
      .max(permissionMaxActions)
      .refine((actions) => new Set(actions).size === actions.length, {
        message: "Each action once",
      }),
    binding: bindingNameSchema,
  })
  .superRefine(({ object, actions }, context) => {
    for (const action of actions) {
      if (!isActionOf(object.type, action)) {
        context.addIssue({
          code: "custom",
          path: ["actions"],
          message: `A ${object.type} has no action ${action}`,
        });
      }
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
  });
/** A permission request as a client sends it, with plain string IDs. */
export type PermissionRequest = z.input<typeof permissionRequestSchema>;

/**
 * Requested: asked for, allows nothing yet. Active: granted, allows its
 * actions. Revoked: allows nothing, for good (ask again for a new one).
 */
export const permissionStatusSchema = z.enum([
  "requested",
  "active",
  "revoked",
]);
export type PermissionStatus = z.infer<typeof permissionStatusSchema>;

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
  grantedBy: string | null;
  grantedAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
}

/**
 * A signed-in person's permissions, over `/rpc`: every call checks the
 * session and the person's role again.
 */
export interface PermissionsApi {
  /**
   * Asks for a permission for an App or agent; it allows nothing until an
   * admin grants it. Admins and builders.
   */
  request: (request: PermissionRequest) => Promise<Permission>;
  /** Grants a requested permission. Admins only. */
  grant: (id: string) => Promise<Permission>;
  /** Revokes a permission; the next call that needs it is refused. Admins only. */
  revoke: (id: string) => Promise<Permission>;
  /** Every permission, or one App's or agent's. Admins and builders. */
  list: (subject?: PermissionSubjectInput) => Promise<Permission[]>;
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
export const authoritySchema = z.strictObject({
  subject: permissionSubjectSchema,
  onBehalfOf: identifierSchema,
  mode: z.enum(["interactive", "workflow"]),
});
export type Authority = z.infer<typeof authoritySchema>;

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
});
