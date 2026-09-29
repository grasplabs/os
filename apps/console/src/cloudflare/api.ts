/**
 * A small client for the Cloudflare REST API, as the console uses it to
 * provision and deploy client accounts. It speaks the API's envelope
 * (`{ success, errors, result }`) and retries what is safe to retry.
 *
 * The token (the deployer's, from Secrets Store) goes only into the
 * `Authorization` header: never into a log, an error or a returned value
 * (threat model R17, CO3).
 */
import { whenAborted } from "@grasp-os/shared/deadline";
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
  /**
   * The bearer token for a call that takes another one than the account's:
   * an assets upload session's. Kept out of errors like the account's.
   */
  bearer?: string;
  /**
   * Whether sending it twice does no more than sending it once, which
   * decides whether it's retried after a server error or no answer. By
   * default, what its method says: a content-addressed upload is a POST that
   * may be retried, a script upload with a Durable Object migration a PUT
   * that mustn't.
   */
  idempotent?: boolean;
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
  /**
   * The data a GraphQL Analytics API `query` answers with `variables`,
   * checked against `schema`. Data it answers alongside errors (a field it
   * couldn't read) is taken; errors alone throw.
   */
  graphql: <T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>
  ) => Promise<T>;
}

export interface CloudflareApiOptions {
  token: string;
  /** The first retry's wait, doubling after; tests pass 0. */
  retryDelayMs?: number;
  /**
   * The most one call waits between its attempts, all waits together: a
   * retry that would wait past it isn't made, and the call fails as its
   * last attempt did. Unset, a call makes all its attempts.
   */
  waitBudgetMs?: number;
  /**
   * Stops every call made through the client: requests under way are
   * aborted, and none is retried or waited for after. Unset, calls run to
   * their end.
   */
  signal?: AbortSignal;
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

/** A GraphQL answer: its data, and its errors, if any. */
const graphqlSchema = z.object({
  data: z.unknown().nullish(),
  errors: z
    .array(z.object({ message: z.string() }))
    .nullish()
    .transform((errors) => errors ?? []),
});

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
  waitBudgetMs = Number.POSITIVE_INFINITY,
  signal,
}: CloudflareApiOptions): CloudflareApi => {
  /** Throws the client's abort reason once its signal has aborted. */
  const stopIfAborted = (): void => {
    signal?.throwIfAborted();
  };

  /** Waits `ms` between attempts, or less, throwing, if the client is stopped. */
  const pause = async (ms: number): Promise<void> => {
    await (signal === undefined
      ? scheduler.wait(ms)
      : Promise.race([scheduler.wait(ms), whenAborted(signal)]));
  };

  const send = async (call: ApiCall): Promise<Response | null> => {
    const url = new URL(`${cloudflareApiBase}${call.path}`);
    for (const [name, value] of Object.entries(call.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const headers = new Headers(call.headers);
    headers.set("authorization", `Bearer ${call.bearer ?? token}`);
    let body: BodyInit | undefined = call.body;
    if (call.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(call.json);
    }
    try {
      return await fetch(url, { method: call.method, headers, body, signal });
    } catch {
      // Stopped by the client's signal: not a lost answer to retry.
      stopIfAborted();
      // A network error: no answer, and nothing of it is kept, since its
      // message could echo the request.
      return null;
    }
  };

  /**
   * Whether a call that got `status` (0 for no answer) may be tried again
   * after attempt `attempt` (from 0): a 429, whose call was refused before
   * it was applied, and a server error or no answer for a call sending
   * which twice does no more than once.
   */
  const retryable = (call: ApiCall, status: number, attempt: number) =>
    attempt + 1 < maxAttempts &&
    (status === 429 ||
      ((status === 0 || status >= 500) &&
        (call.idempotent ?? idempotentMethods.has(call.method))));

  /**
   * How long to wait before the attempt after `attempt`, as `response`
   * asks or doubling; undefined when that would take a call that waited
   * `waited` already past its budget.
   */
  const waitBefore = (
    response: Response | null,
    attempt: number,
    waited: number
  ): number | undefined => {
    const wait = retryAfterMs(response) ?? retryDelayMs * 2 ** attempt;
    return waited + wait > waitBudgetMs ? undefined : wait;
  };

  /** Sends `call`, retrying what is safe to retry; `attempt` counts from 0. */
  const page = async <T>(
    call: ApiCall,
    schema: z.ZodType<T>,
    attempt = 0,
    waited = 0
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
    const wait = retryable(call, status, attempt)
      ? waitBefore(response, attempt, waited)
      : undefined;
    if (wait === undefined) {
      throw new CloudflareApiError(
        call.method,
        call.path,
        status,
        envelope?.errors ?? []
      );
    }
    await pause(wait);
    return await page(call, schema, attempt + 1, waited + wait);
  };

  /** Sends a GraphQL query, retrying as `page` does; `attempt` counts from 0. */
  const graphql = async <T>(
    query: string,
    variables: Record<string, unknown>,
    schema: z.ZodType<T>,
    attempt = 0,
    waited = 0
  ): Promise<T> => {
    // A query changes nothing, so it's safe to send again.
    const call: ApiCall = {
      method: "POST",
      path: "/graphql",
      json: { query, variables },
      idempotent: true,
    };
    const response = await send(call);
    const status = response?.status ?? 0;
    if (response?.ok === true) {
      const answer = graphqlSchema.parse(await response.json());
      if (answer.data === null || answer.data === undefined) {
        throw new CloudflareApiError(
          call.method,
          call.path,
          status,
          answer.errors.map(({ message }) => ({ code: 0, message }))
        );
      }
      return schema.parse(answer.data);
    }
    const wait = retryable(call, status, attempt)
      ? waitBefore(response, attempt, waited)
      : undefined;
    if (wait === undefined) {
      throw new CloudflareApiError(call.method, call.path, status, []);
    }
    await pause(wait);
    return await graphql(query, variables, schema, attempt + 1, waited + wait);
  };

  return {
    page,
    graphql,
    call: async (call, schema) => {
      const { result } = await page(call, schema);
      return result;
    },
  };
};

/** Refusals a later attempt may get past: a timeout, a rate limit. */
const transientStatuses: ReadonlySet<number> = new Set([408, 429]);

/**
 * Whether `error` is Cloudflare refusing the call for good: a 4xx other
 * than a timeout or a rate limit, which trying again won't change.
 */
export const isRefused = (error: unknown): error is CloudflareApiError =>
  error instanceof CloudflareApiError &&
  error.status >= 400 &&
  error.status < 500 &&
  !transientStatuses.has(error.status);

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
