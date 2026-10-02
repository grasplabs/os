// Folding choices the person makes here (the app's sidebar, a page's
// sidebar), kept in a cookie for this browser: read at once on load, so a
// folded sidebar never flashes open, and written through the Cookie Store
// API. Not a secret, and no server reads them.

const aYear = 365 * 24 * 60 * 60 * 1000;

/** The cookie `name`'s value, if this browser has it. */
const readCookie = (name: string): string | undefined => {
  for (const pair of document.cookie.split("; ")) {
    const [key, value] = pair.split("=");
    if (key === name) {
      return value;
    }
  }
  return undefined;
};

/** Whether `name` was left folded, or undefined if it never was chosen. */
export const readFolded = (name: string): boolean | undefined => {
  const kept = readCookie(`grasp-${name}-folded`);
  if (kept === "yes") {
    return true;
  }
  return kept === "no" ? false : undefined;
};

/** Keeps whether `name` is folded, for a year. */
export const keepFolded = async (
  name: string,
  folded: boolean
): Promise<void> => {
  try {
    await cookieStore.set({
      name: `grasp-${name}-folded`,
      value: folded ? "yes" : "no",
      path: "/",
      sameSite: "lax",
      expires: Date.now() + aYear,
    });
  } catch {
    // Without the Cookie Store API the choice lasts until the page reloads.
  }
};
