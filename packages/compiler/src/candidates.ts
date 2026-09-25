const whitespace = /\s+/u;
const quotes = /["'`]/u;
/** Quotes and punctuation around a class in code: `"flex",` or `("p-2")`. */
const before = new Set(['"', "'", "`", "(", "{", ","]);
const after = new Set(['"', "'", "`", ")", "}", ",", ";"]);
/**
 * Longer tokens aren't classes (the kit's longest is under 100
 * characters); skipping them keeps a build's work in step with its size.
 */
const longestCandidate = 300;

/** A token without the quotes and punctuation around it. */
const unwrap = (token: string): string => {
  let start = 0;
  let end = token.length;
  while (start < end && before.has(token.charAt(start))) {
    start += 1;
  }
  while (end > start && after.has(token.charAt(end - 1))) {
    end -= 1;
  }
  return token.slice(start, end);
};

/**
 * Tailwind class candidates in a source file. Tailwind's own scanner is
 * native code that can't run in a Worker; like it, this overshoots, and
 * Tailwind skips tokens that aren't classes. Each whitespace-separated token
 * counts as it is, without the quotes and punctuation around it (which keeps
 * quotes inside a class, as in `[&_svg:not([class*='size-'])]:size-4`), and
 * split at quotes (for `className="flex`).
 */
export const extractCandidates = (source: string): string[] =>
  source
    .split(whitespace)
    .flatMap((token) =>
      token.length > longestCandidate
        ? []
        : [token, unwrap(token), ...token.split(quotes)]
    )
    .filter((token) => token.length > 0);
