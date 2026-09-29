/**
 * Thrown to a rollout's run by a step of a client that found the rollout
 * cancelled and ended the client there (src/rollout/workflow.ts): the run
 * goes no further.
 */
export class ClientEndedError extends Error {
  override name = "ClientEndedError";
}
