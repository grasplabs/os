import { errorFields, log } from "@grasp-os/shared/log";
import type { z } from "zod";

// Composio's REST API, as connect calls it: the only place in Grasp that
// does. Core reaches Composio only through connect, and nothing but connect
// holds the key, a Worker secret the console sets (`COMPOSIO_API_KEY`).
// While it is unset, nothing of Composio is offered or reached.
//
// Everything Composio sends is untrusted: each answer is read up to a size
// cap and validated before anything uses it. A redirect is never followed,
// so the key goes to Composio's API host and nowhere else.

/** Composio's REST API. */
export const composioApiBase = "https://backend.composio.dev/api/v3.1";

/** How long one request to Composio may take. */
const requestTimeoutMs = 10_000;

/** Largest answer connect reads from Composio's API, in bytes. */
const maxResponseBytes = 4 * 1024 * 1024;

/** Composio didn't answer, or answered something connect can't use. */
export class ComposioError extends Error {
  /** Composio's HTTP status, when it answered with one. */
  readonly status: number | undefined;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message, { cause });
    this.name = "ComposioError";
    this.status = status;
  }
}

/** Connect's Composio key, or `undefined` while it is unset. */
export const composioKey = (env: Env): string | undefined =>
  env.COMPOSIO_API_KEY === undefined || env.COMPOSIO_API_KEY === ""
    ? undefined
    : env.COMPOSIO_API_KEY;

/** The body as text, read up to `maxResponseBytes` as it arrives. */
const readCapped = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a stream is read in order
      const chunk = await reader?.read();
      if (chunk === undefined || chunk.done) {
        break;
      }
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) {
        throw new ComposioError("The answer isn't a byte stream");
      }
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) {
        throw new ComposioError(`The answer is over ${maxResponseBytes} bytes`);
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    // Never in place of the error that ended the read.
    await reader?.cancel().catch((error: unknown) => {
      log.warn("composio.cancel_failed", errorFields(error));
    });
  }
  parts.push(decoder.decode());
  return parts.join("");
};

/** One request to Composio's API. */
export interface ComposioRequest<Schema extends z.ZodType> {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path under the API's base, with its query, such as `/toolkits`. */
  path: string;
  body?: object;
  /** What the answer must be. */
  schema: Schema;
}

/**
 * Sends one request to Composio's API with `key`, and returns its answer,
 * validated by `schema`. Throws {@link ComposioError} when Composio doesn't
 * answer, answers with an error or redirect, or answers something else.
 * Logs the method, the path's first segment and the status only: never the
 * key, the query or a body.
 */
export const composioRequest = async <Schema extends z.ZodType>(
  key: string,
  { method = "GET", path, body, schema }: ComposioRequest<Schema>
): Promise<z.infer<Schema>> => {
  const url = new URL(`${composioApiBase}${path}`);
  const [, area = ""] = path.split(/[/?]/u);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        "x-api-key": key,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // A redirect could carry the key to another host: never follow.
      redirect: "manual",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    log.warn("composio.failed", { method, area, ...errorFields(error) });
    throw new ComposioError("Composio didn't answer", undefined, error);
  }
  log.info("composio.request", { method, area, status: response.status });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ComposioError(
      `Composio answered ${response.status}`,
      response.status
    );
  }
  let parsed: unknown;
  try {
    const text = await readCapped(response);
    parsed = text === "" ? null : JSON.parse(text);
  } catch (error) {
    throw error instanceof ComposioError
      ? error
      : new ComposioError("Composio's answer isn't JSON", undefined, error);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ComposioError("Composio's answer isn't one connect can read");
  }
  return result.data;
};
