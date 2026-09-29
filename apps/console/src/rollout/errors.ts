/** Why staff's action on a rollout was refused, as the page words it. */
export const rolloutErrorCodes = [
  /** The console has no CLIENT_DOMAIN, so no client can be deployed. */
  "domain_not_set",
  /** The release isn't imported. */
  "release_not_imported",
  /** No active client is in what the rollout was started for. */
  "no_targets",
  /** It would take its run past the step budget: roll out to fewer clients at a time. */
  "too_large",
  /** Another rollout is running or waiting for approval. */
  "rollout_running",
  /** The rollout isn't waiting for approval. */
  "not_waiting",
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
