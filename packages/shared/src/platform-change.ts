import { z } from "zod";

import { identifierSchema } from "./ids.ts";

/**
 * What the console sets as core's `PLATFORM_CHANGE` var on every version
 * it deploys: who made the change, what it was (a release, a setting),
 * the release the version runs and when it was made. Core records it in
 * the deployment's audit log as `platform.updated`, once per version
 * (core's src/platform-updates.ts). A rollback, which makes no version,
 * the console sends in a notice instead (`platformUpdatePath`).
 * Identifiers only, as every audit detail is.
 */
export const platformChangeSchema = z.object({
  /** The staff member, or the rollout, that made the change. */
  by: identifierSchema,
  /**
   * What changed, e.g. `release`, `secrets` (new secrets on the same
   * release: shared ones, or the deployment's own after a rotation),
   * `settings` (its flags or sign-in, on the same release) or `rollback`.
   */
  what: identifierSchema,
  /** The release the version runs, e.g. `r000123-abcdef0`. */
  release: identifierSchema,
  /** When the console made the change. */
  at: z.iso.datetime(),
});
export type PlatformChange = z.infer<typeof platformChangeSchema>;

/**
 * Where the console tells core of a platform update that made no new
 * version, a rollback to one core has run before, which the cron would
 * never record again: core records it as `platform.updated` (core's
 * src/platform-updates.ts). Behind the router-secret check like every
 * route, and signed (`platformUpdateSignatureHeader`).
 */
export const platformUpdatePath = "/platform/updates";

/**
 * The header carrying the notice's signature: lowercase hex HMAC-SHA256
 * of the request body, with the key `hkdfHmacKey` derives from core's
 * auth secret for `platformUpdatePurpose`.
 */
export const platformUpdateSignatureHeader = "x-grasp-console-signature";

/** The purpose a notice's signing key is derived for (`hkdfHmacKey`). */
export const platformUpdatePurpose = "grasp-os platform update key";

/** The most bytes a notice's body may have: far above what one takes. */
export const platformUpdateMaxBytes = 4096;

/**
 * How long after it was sent core takes a notice, and how far ahead of
 * core's clock it may be: a notice caught on its way can't be sent again
 * later.
 */
export const platformUpdateMaxSkewMs = 5 * 60 * 1000;

/** What the console tells core: the version now running, and the change. */
export const platformUpdateNoticeSchema = z.object({
  /** The version of core all traffic goes to now. */
  versionId: identifierSchema,
  change: platformChangeSchema,
  /** When the console sent it. */
  sentAt: z.iso.datetime(),
});
export type PlatformUpdateNotice = z.infer<typeof platformUpdateNoticeSchema>;
