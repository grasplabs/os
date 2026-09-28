/**
 * Why a deploy stopped, as its `client_deploys` row and audit event record
 * it: a fixed code, never a message or a response body (threat model R17).
 */
export const deployErrorCodes = [
  /** The release isn't imported, or its manifest no longer parses. */
  "release_not_imported",
  /** A blob in R2 is missing, or isn't what the imported manifest says. */
  "release_blob_mismatch",
  /** Two Workers give one database different migrations. */
  "migration_lists_differ",
  /** A D1 database the release binds exists outside the EU. */
  "database_outside_eu",
  /** An R2 bucket the release binds is outside the EU. */
  "bucket_outside_eu",
  /** A D1 migration failed to apply. */
  "d1_migration_failed",
] as const;

export type DeployErrorCode = (typeof deployErrorCodes)[number];

/** A deploy step that stopped, with the code the deploy records. */
export class DeployError extends Error {
  readonly code: DeployErrorCode;

  constructor(code: DeployErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeployError";
    this.code = code;
  }
}
