import { messageOf } from "@grasp-os/shared/errors";
import { useState } from "react";

import { withSession } from "./core.ts";
import type { Session } from "./core.ts";

interface RunOptions {
  /** Where the reason a change failed goes, instead of `failure`. */
  report?: (reason: string) => void;
  /** What to finish, whatever the outcome, before `busy` ends. */
  afterwards?: () => Promise<void>;
}

/**
 * Runs a change against core on the signed-in person's session: `busy`
 * while it and `afterwards` (such as reading the page's data again) run,
 * and `failure` saying why it didn't go through.
 */
export const useCoreAction = () => {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const run = async <T>(
    action: (session: Session) => Promise<T>,
    { report = setFailure, afterwards }: RunOptions = {}
  ): Promise<T | undefined> => {
    setBusy(true);
    setFailure(undefined);
    let result: T | undefined;
    try {
      result = await withSession(action);
    } catch (error) {
      report(messageOf(error));
    }
    if (afterwards !== undefined) {
      try {
        await afterwards();
      } catch (error) {
        report(messageOf(error));
      }
    }
    setBusy(false);
    return result;
  };
  return { busy, failure, run };
};
