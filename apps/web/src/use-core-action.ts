import { messageOf } from "@grasp-os/shared/errors";
import { useState } from "react";

import { withSession } from "./core.ts";
import type { Session } from "./core.ts";

/**
 * Runs a change against core on the signed-in person's session: `busy`
 * while it runs, and `failure` saying why it didn't go through. `report`
 * sends that reason somewhere else instead.
 */
export const useCoreAction = () => {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const run = async <T>(
    action: (session: Session) => Promise<T>,
    report: (reason: string) => void = setFailure
  ): Promise<T | undefined> => {
    setBusy(true);
    setFailure(undefined);
    let result: T | undefined;
    try {
      result = await withSession(action);
    } catch (error) {
      report(messageOf(error));
    }
    setBusy(false);
    return result;
  };
  return { busy, failure, run };
};
