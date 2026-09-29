import { useState } from "react";

import type { ProvisionErrorCode } from "./control.ts";
import type { ChangeResult } from "./functions.ts";

/** What staff read when the console refuses a change, by its code. */
const refusals: Readonly<Record<ProvisionErrorCode, string>> = {
  domain_not_set:
    "The console has no CLIENT_DOMAIN yet, so no client can get a hostname.",
  release_not_imported: "That release isn't imported.",
  client_exists: "A client with that id exists already: open its page.",
  account_taken: "Another client is on that Cloudflare account.",
  account_in_use:
    "That Cloudflare account already runs Grasp: it's staging, the console's, or another client's.",
  account_unreachable:
    "The deployer isn't a member of that Cloudflare account: add it first.",
  already_running: "Its provisioning is running already.",
  not_provisioning: "It isn't being provisioned, so there's nothing to do.",
};

/** What staff read when a change fails for any other reason, such as a field the form let through. */
const failed = "That didn't work. Check the fields and try again.";

/** Runs `action`: null when it worked, else what went wrong, worded. Never throws. */
const failureOf = async (
  action: () => Promise<ChangeResult>
): Promise<string | null> => {
  try {
    const { refused } = await action();
    return refused === null ? null : refusals[refused];
  } catch {
    return failed;
  }
};

/**
 * A staff action on a client page: `run` runs it, `busy` holds while it
 * does (cleared whether it worked or not), and `failure` says why the
 * last one failed, until the next.
 */
export const useAction = () => {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (action: () => Promise<ChangeResult>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const outcome = await failureOf(action);
    setBusy(false);
    setFailure(outcome);
  };
  return { busy, failure, run };
};
