// The built-in blueprints, generated into dist/ by build-blueprints.ts.

/** A built-in blueprint, as the build embeds it. */
export interface BuiltinBlueprint {
  /** Its folder's name under apps/core/blueprints/, which never changes. */
  id: string;
  name: string;
  description: string;
  /** The App's files: their text, by path. */
  files: Readonly<Record<string, string>>;
}

/** The release's built-in blueprints, in id order. */
declare const blueprints: readonly BuiltinBlueprint[];
export default blueprints;
