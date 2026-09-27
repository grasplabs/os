/**
 * Splits a D1 `/query` body into its statements, as the API does: at
 * semicolons outside string literals, quoted identifiers, comments and a
 * trigger's `BEGIN … END` body. The fake Cloudflare API runs each on a real
 * D1 database, which takes one statement at a time.
 */

/** What closes each quote that opens a literal or an identifier. */
const closers: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  "`": "`",
  "[": "]",
};

const wordPattern = /[A-Za-z_][\w$]*/uy;
const wordCharacter = /[\w$]/u;
const triggerPattern = /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/iu;
const onlyCommentsPattern = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*$/u;

/** Where the quote opened at `start` ends: past its closer, a doubled one skipped. */
const pastQuote = (sql: string, start: number, closer: string): number => {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === closer) {
      // A doubled quote (`''`) is an escaped one; brackets don't escape.
      if (closer !== "]" && sql[index + 1] === closer) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
};

/** Where the comment at `start` ends, or `start` if none begins there. */
const pastComment = (sql: string, start: number): number => {
  const opening = sql.slice(start, start + 2);
  if (opening === "--") {
    const end = sql.indexOf("\n", start);
    return end === -1 ? sql.length : end + 1;
  }
  if (opening === "/*") {
    const end = sql.indexOf("*/", start + 2);
    return end === -1 ? sql.length : end + 2;
  }
  return start;
};

/** How a keyword changes the depth of trigger bodies and `CASE`s in them. */
const depthChange = (word: string, statement: string, depth: number) => {
  const keyword = word.toUpperCase();
  if (keyword === "BEGIN" && depth === 0) {
    return triggerPattern.test(statement) ? 1 : 0;
  }
  if (depth > 0 && keyword === "CASE") {
    return 1;
  }
  if (depth > 0 && keyword === "END") {
    return -1;
  }
  return 0;
};

/** The statements of `sql`, trimmed, without ones that are only comments. */
export const sqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  const add = (statement: string) => {
    if (!onlyCommentsPattern.test(statement)) {
      statements.push(statement.trim());
    }
  };
  let start = 0;
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index] ?? "";
    const afterComment = pastComment(sql, index);
    const closer = closers[character];
    wordPattern.lastIndex = index;
    const word = wordCharacter.test(sql[index - 1] ?? "")
      ? undefined
      : wordPattern.exec(sql)?.[0];
    if (afterComment !== index) {
      index = afterComment;
    } else if (closer !== undefined) {
      index = pastQuote(sql, index, closer);
    } else if (word === undefined) {
      if (character === ";" && depth === 0) {
        add(sql.slice(start, index));
        start = index + 1;
      }
      index += 1;
    } else {
      depth += depthChange(word, sql.slice(start, index), depth);
      index += word.length;
    }
  }
  add(sql.slice(start));
  return statements;
};
