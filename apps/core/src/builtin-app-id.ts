import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";

// Its own module, importing only shared schemas, so build-blueprints.ts
// (run by Node) checks each built-in's App ID as the install makes it, and
// permissions.ts knows a built-in's owner without importing App access.

// Shared, so the frontend leaves the built-ins' permissions out of what an
// admin decides.
export { builtinOwner } from "@grasp-os/shared/apps";

/**
 * The App of the built-in blueprint `id`, under this ID: no other has it.
 * Throws for an `id` that makes no valid App ID, such as one too long.
 */
export const builtinAppId = (id: string): AppId =>
  appIdSchema.parse(`builtin-${id}`);
