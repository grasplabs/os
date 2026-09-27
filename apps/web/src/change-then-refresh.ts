/**
 * Makes `change`, then reads the page's data again with `refresh`, whatever
 * the outcome: even a failed change may have changed something (a removal
 * whose disconnect is still pending, say). Run as the action itself, so the
 * controls stay off until the data is back: they act on what is shown.
 * Outside components, as the React Compiler can't compile `try`/`finally`.
 */
export const changeThenRefresh = async (
  change: () => Promise<unknown>,
  refresh: () => Promise<void>
): Promise<void> => {
  try {
    await change();
  } finally {
    await refresh();
  }
};
