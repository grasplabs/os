/**
 * The value of a JSON var the console sets. It arrives parsed; one set as
 * text (`wrangler dev --var NAME:<json>`) is parsed here, and is `undefined`
 * if it isn't JSON.
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
