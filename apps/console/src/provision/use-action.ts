import { useState } from "react";

/** Runs `action`: null when it worked, else why it didn't. Never throws. */
const failureOf = async (
  action: () => Promise<void>
): Promise<string | null> => {
  try {
    await action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "It didn't work.";
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
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    const failed = await failureOf(action);
    setBusy(false);
    setFailure(failed);
  };
  return { busy, failure, run };
};
