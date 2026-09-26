import { z } from "zod";

/**
 * The longest an ID, or any other identifier, may be: room for provider IDs
 * (Microsoft Graph item IDs run past 100 characters), not for content.
 * Everything that names something has to fit in an audit event, which names
 * things and never carries their content.
 */
export const identifierMaxLength = 256;

/** An identifier: non-empty, and at most {@link identifierMaxLength}. */
export const identifierSchema = z.string().min(1).max(identifierMaxLength);

/**
 * Creates the schema for one kind of ID. The brand exists only in the type
 * system: an `AppId` can't be passed where a `RunId` is expected, and a plain
 * string becomes an ID only by parsing it.
 *
 * IDs are opaque: nothing may read meaning into their contents, and each store
 * picks how it mints them, so the only rules are those of an identifier: never
 * empty, and short enough for the audit log.
 *
 * Marked free of side effects so bundlers drop the ID schemas a consumer
 * doesn't import.
 */
/* @__NO_SIDE_EFFECTS__ */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the brand is type-only by design
const idSchema = <Brand extends string>() => identifierSchema.brand<Brand>();

/** An App: its screens, workflows and permissions, installed as one unit. */
export const appIdSchema = idSchema<"AppId">();
export type AppId = z.infer<typeof appIdSchema>;

/** A workflow inside an App. */
export const workflowIdSchema = idSchema<"WorkflowId">();
export type WorkflowId = z.infer<typeof workflowIdSchema>;

/** One run of a workflow. */
export const runIdSchema = idSchema<"RunId">();
export type RunId = z.infer<typeof runIdSchema>;

/** A workspace. */
export const workspaceIdSchema = idSchema<"WorkspaceId">();
export type WorkspaceId = z.infer<typeof workspaceIdSchema>;

/** A chat in a workspace. */
export const chatIdSchema = idSchema<"ChatId">();
export type ChatId = z.infer<typeof chatIdSchema>;

/** A knowledge collection. */
export const collectionIdSchema = idSchema<"CollectionId">();
export type CollectionId = z.infer<typeof collectionIdSchema>;

/** A document in a knowledge collection. */
export const documentIdSchema = idSchema<"DocumentId">();
export type DocumentId = z.infer<typeof documentIdSchema>;

/** A connection to an outside system, held by connect. */
export const connectionIdSchema = idSchema<"ConnectionId">();
export type ConnectionId = z.infer<typeof connectionIdSchema>;

/** An agent that works for people, such as the chat agent of a workspace. */
export const agentIdSchema = idSchema<"AgentId">();
export type AgentId = z.infer<typeof agentIdSchema>;

/** One permission granted to an agent or App. */
export const permissionIdSchema = idSchema<"PermissionId">();
export type PermissionId = z.infer<typeof permissionIdSchema>;
