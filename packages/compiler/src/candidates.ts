const whitespace = /\s+/u;
const quotes = /["'`]/u;
/** Quotes and punctuation around a class in code: `"flex",` or `("p-2")`. */
const wrapping = /^["'`({,]+|["'`)},;]+$/gu;

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
    .flatMap((token) => [
      token,
      token.replaceAll(wrapping, ""),
      ...token.split(quotes),
    ])
    .filter((token) => token.length > 0);
