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
  /** Another runner took the client over while the deploy ran: a rollback. */
  "runner_replaced",
  /** The account's script ran a Durable Object migration the release doesn't have. */
  "unknown_migration_tag",
  /** A binding in the manifest names a placeholder the console doesn't fill. */
  "unknown_placeholder",
  /** A client setting isn't a deployment config var core reads. */
  "unknown_setting",
  /** A client setting, or the config derived for it, isn't one core would take. */
  "setting_invalid",
  /**
   * The client's sign-in can't be made: its record doesn't parse, or it
   * names an IdP the console has no app id for.
   */
  "sign_in_incomplete",
  /** A setting, shared secret or var takes a name something else has. */
  "binding_name_taken",
  /** A shared secret takes a name reserved for a derived one. */
  "reserved_secret_name",
  /** A Worker's required secret has no value. */
  "missing_secret",
  /** The release has a Worker the console doesn't deploy. */
  "unknown_worker",
  /** The release's Workers bind each other as services in a cycle. */
  "service_binding_cycle",
  /** The client's id can't be its hostname: not a lowercase DNS label, or reserved. */
  "invalid_client_id",
  /** No free workers.dev subdomain was found for the account. */
  "subdomain_unavailable",
  /** Core's address isn't an `https://*.workers.dev` origin. */
  "invalid_core_origin",
  /** Core didn't answer its health check as the version this deploy made live. */
  "smoke_check_failed",
  /** The router's map gives the client's hostname to another client. */
  "hostname_taken",
  /** The router's map is at a later secrets generation than this deploy. */
  "generation_behind",
  /** The router's map has an entry for the hostname the router can't read. */
  "router_entry_invalid",
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
