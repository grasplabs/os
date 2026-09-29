// Response headers every Grasp-made HTTP response carries, whether core or
// the router in front of it makes it.

/** Carries the request ID back to the caller, on every response. */
export const requestIdHeader = "x-request-id";

/** Browsers keep to https for this long after a visit: one year. */
const hstsMaxAgeSeconds = 365 * 24 * 60 * 60;

/** `strict-transport-security`, sent on https only: browsers ignore it over http. */
export const strictTransportSecurity = `max-age=${hstsMaxAgeSeconds}; includeSubDomains`;

/**
 * `stream`'s bytes, read up to `max` of them: undefined for a stream
 * longer than that, counted on what it holds, whatever it says its size is.
 */
export const readAtMost = async (
  stream: ReadableStream<Uint8Array>,
  max: number
): Promise<Uint8Array<ArrayBuffer> | undefined> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream reads in order
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    length += value.byteLength;
    if (length > max) {
      // oxlint-disable-next-line no-await-in-loop -- once, then out
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};
