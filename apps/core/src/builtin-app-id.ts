import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";

// Its own module, importing only shared schemas, so build-blueprints.ts
// (run by Node) checks each built-in's App ID as the install makes it, and
// permissions.ts knows a built-in's owner without importing App access.

/** The owner of the built-in blueprints' Apps: Grasp, never a person. */
export const builtinOwner = "grasp";

/**
 * The App of the built-in blueprint `id`, under this ID: no other has it.
 * Throws for an `id` that makes no valid App ID, such as one too long.
 */
export const builtinAppId = (id: string): AppId =>
  appIdSchema.parse(`builtin-${id}`);
