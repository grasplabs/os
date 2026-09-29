import { useAction } from "../use-action.ts";
import type { RolloutErrorCode } from "./errors.ts";

/** What staff read when the console refuses a rollout action, by its code. */
const refusals: Readonly<Record<RolloutErrorCode, string>> = {
  domain_not_set:
    "The console has no CLIENT_DOMAIN yet, so no client can be deployed.",
  release_not_imported: "That release isn't imported.",
  no_targets: "No active client is in that scope.",
  ring_zero_only:
    "No active client past ring 0 is in that scope, so it would reach only our own deployments: pick a ring or client that has one.",
  too_large:
    "That's more clients than one rollout takes: roll out one ring or client at a time.",
  rollout_running:
    "Another rollout is running or waiting for approval: finish or cancel it first.",
  not_waiting: "It isn't waiting for approval.",
  not_running: "Its run isn't going, so there's nothing to pause.",
  not_paused: "It isn't paused.",
  unknown_client: "There's no such client.",
  nothing_to_roll_back:
    "The rollout didn't reach that client, so there's nothing to roll back.",
  superseded:
    "Something newer was deployed to that client since: roll out the release you want instead.",
  too_far_back:
    "That client ran an older release than the one right before this rollout's: roll out the release you want instead.",
  rotated_since:
    "That client's secrets rotated since, and its previous versions don't have the new ones: roll out instead.",
  client_busy:
    "Something else is deploying to that client right now: try again in a moment.",
  rollback_failed:
    "The rollback didn't finish: check the client's drift, then try again.",
};

/** A staff action on a rollout (`useAction`), its refusals worded. */
export const useRolloutAction = () => useAction(refusals);
