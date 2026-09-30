// A control's pending state, which must end however the call does. Its
// own module: the React Compiler doesn't compile try/finally inside a
// component.

/**
 * Runs `run` with `pending` set for as long as it takes, cleared however
 * it ends: a button it disables never stays disabled.
 */
export const whilePending = async <T>(
  pending: (on: boolean) => void,
  run: () => Promise<T>
): Promise<T> => {
  pending(true);
  try {
    return await run();
  } finally {
    pending(false);
  }
};
