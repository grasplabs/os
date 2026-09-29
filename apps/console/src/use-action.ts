import { useState } from "react";

/** A field the page checks itself, and what it says of it: shown as it is. */
export class InvalidFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFieldError";
  }
}

/** What a change answers: refused with a code, or not (null). */
export interface Refusable<Code extends string> {
  refused: Code | null;
}

/** What staff read when a change fails for any other reason, such as a field the form let through. */
const failed = "That didn't work. Check the fields and try again.";

/** Runs `action`: null when it worked, else what went wrong, worded. Never throws. */
const failureOf = async <Code extends string>(
  refusals: Readonly<Record<Code, string>>,
  action: () => Promise<Refusable<Code>>
): Promise<string | null> => {
  try {
    const { refused } = await action();
    return refused === null ? null : refusals[refused];
  } catch (error) {
    return error instanceof InvalidFieldError ? error.message : failed;
  }
};

/**
 * Runs `change`, then `refresh`, whether `change` worked or not: a page
 * read again after its action, so it shows where things are either way.
 */
export const thenRefresh = async <T>(
  change: () => Promise<T>,
  refresh: () => Promise<void>
): Promise<T> => {
  try {
    return await change();
  } finally {
    await refresh();
  }
};

/**
 * A staff action on a page: `run` runs it, `busy` holds while it does
 * (cleared whether it worked or not), and `failure` says why the last one
 * failed, until the next: a refusal as `refusals` words its code, a field
 * the page checked as it says, anything else as `failed`. Never throws.
 */
export const useAction = <Code extends string>(
  refusals: Readonly<Record<Code, string>>
) => {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (action: () => Promise<Refusable<Code>>): Promise<void> => {
    setBusy(true);
    setFailure(null);
    // Never throws, so `busy` always clears.
    const outcome = await failureOf(refusals, action);
    setBusy(false);
    setFailure(outcome);
  };
  return { busy, failure, run };
};
