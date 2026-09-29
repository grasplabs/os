// The built-in blueprints, generated into dist/ by build-blueprints.ts.

import type { DeclaredCollection } from "@grasp-os/shared/knowledge";
import type { DeclaredPermission } from "@grasp-os/shared/permissions";

/** A built-in blueprint, as the build embeds it. */
export interface BuiltinBlueprint {
  /** Its folder's name under apps/core/blueprints/, which never changes. */
  id: string;
  name: string;
  description: string;
  /** The collections it keeps records in, which the install creates. */
  collections: readonly DeclaredCollection[];
  /** What each App created from it asks for, each waiting for an admin. */
  permissions: readonly DeclaredPermission[];
  /** The App's files: their text, by path. */
  files: Readonly<Record<string, string>>;
}

/** The release's built-in blueprints, in id order. */
declare const blueprints: readonly BuiltinBlueprint[];
export default blueprints;
