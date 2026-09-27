import { z } from "zod";

import { identifierSchema } from "./ids.ts";

/**
 * What the console sets as core's `PLATFORM_CHANGE` var on every version
 * it deploys: who made the change, what it was (a release, a setting),
 * the release the version runs and when it was made. Core records it in
 * the deployment's audit log as `platform.updated`, once per version
 * (core's src/platform-updates.ts). Identifiers only, as every audit
 * detail is.
 */
export const platformChangeSchema = z.object({
  /** The staff member, or the rollout, that made the change. */
  by: identifierSchema,
  /** What changed, e.g. `release` or `settings`. */
  what: identifierSchema,
  /** The release the version runs, e.g. `r000123-abcdef0`. */
  release: identifierSchema,
  /** When the console made the change. */
  at: z.iso.datetime(),
});
export type PlatformChange = z.infer<typeof platformChangeSchema>;
