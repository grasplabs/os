/**
 * A small client for the Cloudflare REST API, as the console uses it to
 * provision and deploy client accounts. It speaks the API's envelope
 * (`{ success, errors, result }`) and retries what is safe to retry.
 *
 * The token (the deployer's, from Secrets Store) goes only into the
 * `Authorization` header: never into a log, an error or a returned value
 * (threat model R17, CO3).
 */
import { z } from "zod";

export const cloudflareApiBase = "https://api.cloudflare.com/client/v4";

/** Attempts per call, the first included. */
const maxAttempts = 4;

/** Waits before retry n (0-based): `retryDelayMs * 2^n`. */
const defaultRetryDelayMs = 500;

/** The longest a 429's `Retry-After` makes a call wait. */
const maxRetryAfterMs = 60_000;

/**
 * How long a 429 asks to wait, in ms, capped: its `Retry-After` in seconds,
 * as Cloudflare sends it. Undefined when it names none, or no number.
 */
const retryAfterMs = (response: Response | null): number | undefined => {
  const header =
    response?.status === 429 ? response.headers.get("retry-after") : null;
  const seconds = Number(header ?? "");
  if (
    header === null ||
    header.trim() === "" ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return undefined;
  }
  return Math.min(seconds * 1000, maxRetryAfterMs);
};

/**
 * Methods Cloudflare applies at most once however often they're sent. Only
 * these are retried after a server error, whose request may have been
 * applied; a 429 was refused before it was, so every method retries it.
 */
const idempotentMethods: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
]);

/** An error or message in the API's envelope. */
interface ApiMessage {
  code: number;
  message: string;
}

/** A call Cloudflare refused, or that never got an answer. */
export class CloudflareApiError extends Error {
  /** The HTTP status; 0 when no response came. */
  readonly status: number;
  /** Cloudflare's error codes, such as 10007 for "not found". */
  readonly codes: readonly number[];

  constructor(
    method: string,
    path: string,
    status: number,
    errors: readonly ApiMessage[]
  ) {
    const reasons = errors.map(({ code, message }) => `${code} ${message}`);
    super(
      `Cloudflare API ${method} ${path} failed (${status === 0 ? "no response" : status})${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`
    );
    this.name = "CloudflareApiError";
    this.status = status;
    this.codes = errors.map(({ code }) => code);
  }
}

/** Where a page sits in its list. */
export interface ResultInfo {
  total_count?: number;
}

export interface ApiCall {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Below the API base, such as `/accounts/<id>/d1/database`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is: multipart form data, for uploads. */
  body?: FormData;
}

/** A result, with the page of a list it is. */
export interface Page<T> {
  result: T;
  resultInfo?: ResultInfo;
}

export interface CloudflareApi {
  /** The result of `call`, checked against `schema`. */
  call: <T>(call: ApiCall, schema: z.ZodType<T>) => Promise<T>;
  /** The same, with the page it was: for lists. */
  page: <T>(call: ApiCall, schema: z.ZodType<T>) => Promise<Page<T>>;
}

export interface CloudflareApiOptions {
  token: string;
  /** The first retry's wait, doubling after; tests pass 0. */
  retryDelayMs?: number;
}

/**
 * The API's envelope. A response without one (an edge error page) fails by
 * its status alone.
 */
const envelopeSchema = z.object({
  success: z.boolean(),
  errors: z.array(z.object({ code: z.number(), message: z.string() })),
  result: z.unknown(),
  result_info: z.object({ total_count: z.number().optional() }).nullish(),
});
type Envelope = z.infer<typeof envelopeSchema>;

/** The envelope of a response, or null when it has none (an edge error page). */
const envelopeOf = async (response: Response): Promise<Envelope | null> => {
  try {
    const parsed = envelopeSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** A client for the API with `token`. */
export const cloudflareApi = ({
  token,
  retryDelayMs = defaultRetryDelayMs,
}: CloudflareApiOptions): CloudflareApi => {
  const send = async (call: ApiCall): Promise<Response | null> => {
    const url = new URL(`${cloudflareApiBase}${call.path}`);
    for (const [name, value] of Object.entries(call.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const headers = new Headers(call.headers);
    headers.set("authorization", `Bearer ${token}`);
    let body: BodyInit | undefined = call.body;
    if (call.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(call.json);
    }
    try {
      return await fetch(url, { method: call.method, headers, body });
    } catch {
      // A network error: no answer, and nothing of it is kept, since its
      // message could echo the request.
      return null;
    }
  };

  /** Sends `call`, retrying what is safe to retry; `attempt` counts from 0. */
  const page = async <T>(
    call: ApiCall,
    schema: z.ZodType<T>,
    attempt = 0
  ): Promise<Page<T>> => {
    const response = await send(call);
    const status = response?.status ?? 0;
    const envelope = response === null ? null : await envelopeOf(response);
    if (response?.ok === true && envelope?.success === true) {
      return {
        result: schema.parse(envelope.result),
        resultInfo: envelope.result_info ?? undefined,
      };
    }
    // No answer at all is retried like a server error: the call may or may
    // not have been applied.
    const retryable =
      status === 429 ||
      ((status === 0 || status >= 500) && idempotentMethods.has(call.method));
    if (!retryable || attempt + 1 >= maxAttempts) {
      throw new CloudflareApiError(
        call.method,
        call.path,
        status,
        envelope?.errors ?? []
      );
    }
    await scheduler.wait(retryAfterMs(response) ?? retryDelayMs * 2 ** attempt);
    return await page(call, schema, attempt + 1);
  };

  return {
    page,
    call: async (call, schema) => {
      const { result } = await page(call, schema);
      return result;
    },
  };
};

/** Whether `error` is Cloudflare saying the thing doesn't exist. */
export const isNotFound = (error: unknown): boolean =>
  error instanceof CloudflareApiError && error.status === 404;

/** Items per page of a list: the most every list endpoint allows. */
const perPage = 50;

/** Most pages a list walks: well past any account's resources. */
const maxPages = 20;

/**
 * Every item of a paged list, from page `page` on. Throws past `maxPages`
 * rather than return a partial list, which would read as "not there".
 */
export const listAll = async <T>(
  api: CloudflareApi,
  path: string,
  schema: z.ZodType<T>,
  query: Record<string, string> = {},
  page = 1
): Promise<T[]> => {
  if (page > maxPages) {
    throw new Error(`Listing ${path} passed ${maxPages} pages`);
  }
  const { result, resultInfo } = await api.page(
    {
      method: "GET",
      path,
      query: { ...query, page: String(page), per_page: String(perPage) },
    },
    z.array(schema)
  );
  const total = resultInfo?.total_count;
  const seen = (page - 1) * perPage + result.length;
  if (result.length < perPage || (total !== undefined && seen >= total)) {
    return result;
  }
  return [...result, ...(await listAll(api, path, schema, query, page + 1))];
};
