/**
 * How the workerd smoke run (workerd-smoke.ts) decides that core started:
 * core's own health answer came before workerd exited. Apart from the
 * script so it can be tested without workerd.
 */
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

/** What the smoke run needs of workerd's process. */
export interface WorkerdProcess extends EventEmitter {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

/** How the smoke run polls core's health. */
export interface HealthPoll {
  url: string;
  headers: Record<string, string>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  attempts: number;
  retryDelayMs: number;
}

/**
 * Whether it's core's own health answer: exactly `{"ok":true}`, with the
 * request ID core puts on every response.
 */
export const isCoreHealth = async (response: Response): Promise<boolean> =>
  response.ok &&
  response.headers.has("x-request-id") &&
  (await response.text()) === JSON.stringify({ ok: true });

/**
 * Polls until something answers, then says what's wrong with the answer:
 * nothing when it's core's. Attempts are sequential by design.
 */
export const waitForCore = async (
  poll: HealthPoll,
  attempt = 0
): Promise<string | undefined> => {
  if (attempt >= poll.attempts) {
    return "core did not answer on workerd";
  }
  let response: Response;
  try {
    response = await poll.fetch(poll.url, { headers: poll.headers });
  } catch {
    await sleep(poll.retryDelayMs);
    return await waitForCore(poll, attempt + 1);
  }
  return (await isCoreHealth(response))
    ? undefined
    : `something other than core answers at ${poll.url}`;
};

/** Once workerd exits, how it did. */
const exited = async (workerd: WorkerdProcess): Promise<string> => {
  await once(workerd, "exit");
  const how = workerd.signalCode ?? workerd.exitCode;
  return `workerd exited (${String(how)}) before core answered`;
};

/**
 * Resolves once core answers its health check; rejects when it answers
 * otherwise, never does, or workerd exits first. workerd exits at once
 * when it can't start (its port taken, say): the smoke fails then, rather
 * than polling whatever else listens there.
 */
export const coreStarted = async (
  workerd: WorkerdProcess,
  poll: HealthPoll
): Promise<void> => {
  const failure = await Promise.race([waitForCore(poll), exited(workerd)]);
  if (failure !== undefined) {
    throw new Error(failure);
  }
};
