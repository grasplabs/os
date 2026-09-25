/** A JSON value. Keys whose value is `undefined` are left out, as in JSON. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

// `Array.isArray` doesn't narrow a readonly array type.
const isJsonArray = (value: Json): value is readonly Json[] =>
  Array.isArray(value);

/**
 * JSON with object keys sorted by UTF-16 code unit and no whitespace, so equal
 * values always give the same text, whatever the locale. For values without
 * special number forms this matches RFC 8785 (JCS), so anyone can recompute
 * it. Keys whose value is `undefined` are left out, as `JSON.stringify` does.
 */
export const canonicalJson = (value: Json): string => {
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const members: string[] = [];
    // Keys are unique, so no two compare equal.
    for (const [key, member] of Object.entries(value).toSorted(([a], [b]) =>
      a < b ? -1 : 1
    )) {
      if (member !== undefined) {
        members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
      }
    }
    return `{${members.join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("JSON has no representation for this number");
  }
  return JSON.stringify(value);
};
