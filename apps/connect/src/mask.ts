// Masking: a permission can hold back fields of a connection's results,
// such as the body of a message for one that may see metadata only. It
// names fields by name (`body`), core signs them into each call's
// capability, and connect masks, in each result, every field of those
// names that the called tool declares maskable in its manifest. A masked
// field comes back as `null`. The connector's code never learns of it, so
// it can't leave anything out of the mask.

/** The field a maskable path (dotted, through arrays) names: its last. */
const fieldOf = (path: string): string => path.split(".").at(-1) ?? "";

/** The paths of `maskable` that `fields` names. */
export const maskedPaths = (
  fields: readonly string[],
  maskable: readonly string[]
): string[] => maskable.filter((path) => fields.includes(fieldOf(path)));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Sets the field at `keys` to null, in each element of arrays on the way. */
const maskAt = (node: unknown, keys: readonly string[]): void => {
  if (Array.isArray(node)) {
    for (const item of node) {
      maskAt(item, keys);
    }
    return;
  }
  const [key, ...rest] = keys;
  if (key === undefined || !isRecord(node) || !Object.hasOwn(node, key)) {
    return;
  }
  if (rest.length === 0) {
    node[key] = null;
    return;
  }
  maskAt(node[key], rest);
};

/** The output (JSON text) with every field at `paths` set to null. */
export const masked = (output: string, paths: readonly string[]): string => {
  if (paths.length === 0) {
    return output;
  }
  const value: unknown = JSON.parse(output);
  for (const path of paths) {
    maskAt(value, path.split("."));
  }
  return JSON.stringify(value);
};
