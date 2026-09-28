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
  /** A newer deploy of the same client started: this one no longer runs. */
  "deploy_superseded",
  /** The account's script ran a Durable Object migration the release doesn't have. */
  "unknown_migration_tag",
  /** A binding in the manifest names a placeholder the console doesn't fill. */
  "unknown_placeholder",
  /** A client setting isn't a deployment config var core reads. */
  "unknown_setting",
  /** A setting, shared secret or var takes a name something else has. */
  "binding_name_taken",
  /** A shared secret takes a name reserved for a derived one. */
  "reserved_secret_name",
  /** A Worker's required secret has no value. */
  "missing_secret",
  /** The release has a Worker the console doesn't deploy. */
  "unknown_worker",
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
