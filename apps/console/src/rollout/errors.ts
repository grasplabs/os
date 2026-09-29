/** Why staff's action on a rollout was refused, as the page words it. */
export const rolloutErrorCodes = [
  /** The console has no CLIENT_DOMAIN, so no client can be deployed. */
  "domain_not_set",
  /** The release isn't imported. */
  "release_not_imported",
  /** No active client is in what the rollout was started for. */
  "no_targets",
  /**
   * The ring past 0, or the client, it was started for adds no one past
   * ring 0: it would reach only Grasp's own deployments.
   */
  "ring_zero_only",
  /** It would take its run past the step budget: roll out to fewer clients at a time. */
  "too_large",
  /** Another rollout is running or waiting for approval. */
  "rollout_running",
  /** The rollout isn't waiting for approval. */
  "not_waiting",
  /** The rollout's run isn't going, so it can't be paused. */
  "not_running",
  /** The rollout's run isn't paused. */
  "not_paused",
  /** No such client. */
  "unknown_client",
  /** The rollout didn't reach the client, or recorded nothing to go back to. */
  "nothing_to_roll_back",
  /** Something newer was deployed to the client after the rollout. */
  "superseded",
  /**
   * What the client ran before isn't the release right before the
   * rollout's: its migrations only keep that one working.
   */
  "too_far_back",
  /** The client's secrets rotated since, which its previous versions don't have. */
  "rotated_since",
  /** Another runner (provisioning, another rollout, a rollback) has the client. */
  "client_busy",
  /** The rollback's run failed or was ended before it finished. */
  "rollback_failed",
] as const;
export type RolloutErrorCode = (typeof rolloutErrorCodes)[number];

export class RolloutError extends Error {
  readonly code: RolloutErrorCode;

  constructor(code: RolloutErrorCode, message: string) {
    super(message);
    this.name = "RolloutError";
    this.code = code;
  }
}
