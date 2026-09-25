/**
 * The value of a JSON var the console sets. It arrives parsed; one set from a
 * .dev.vars file is a string, parsed here, and `undefined` if it isn't JSON.
 */
export const jsonVar = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};
