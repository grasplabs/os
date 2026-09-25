/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { runIdSchema } from "@grasp-os/shared/ids";

import type {
  EngineEvent,
  JsonValue,
  ModelRequest,
  WorkflowEngine,
} from "../src/engine.ts";

interface FakeEngineOptions {
  params?: Record<string, unknown>;
  /** Answers the model gateway. */
  model?: (request: ModelRequest) => unknown;
  /** Delivers an event to a wait, or nothing (a timeout). */
  event?: (name: string, options: { type: string }) => EngineEvent;
  /** The workflow's state, shared between engines to share it between runs. */
  state?: Map<string, JsonValue>;
}

/**
 * An in-memory engine with the durable semantics the SDK relies on: a step's
 * result is recorded under its name, and running the workflow again on the
 * same engine replays it (completed steps return their recorded result).
 */
export const createFakeEngine = (options: FakeEngineOptions = {}) => {
  const recorded = new Map<string, unknown>();
  const sleeps: { name: string; milliseconds: number }[] = [];
  const waits: { name: string; type: string; timeout?: number }[] = [];
  const modelRequests: ModelRequest[] = [];
  const decisions: { step: string; from: string }[] = [];
  const state = options.state ?? new Map<string, JsonValue>();

  const durable = async <T>(
    name: string,
    retries: number,
    fn: () => Promise<T>
  ): Promise<T> => {
    if (recorded.has(name)) {
      // SAFETY: only `durable` records under a name, with the result of the
      // same step, which a deterministic workflow asks for with the same T.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return recorded.get(name) as T;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- attempts are sequential by design
        const result = await fn();
        recorded.set(name, result);
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  const engine: WorkflowEngine = {
    runId: runIdSchema.parse("run-1"),
    params: options.params ?? {},
    do: async (name, { retries }, fn) => await durable(name, retries ?? 0, fn),
    sleep: async (name, milliseconds) => {
      await durable(name, 0, async () => {
        sleeps.push({ name, milliseconds });
      });
    },
    waitForEvent: async (name, { type, timeout }) =>
      await durable(name, 0, async () => {
        waits.push({
          name,
          type,
          ...(timeout === undefined ? {} : { timeout }),
        });
        return options.event?.(name, { type }) ?? { received: false };
      }),
    callModel: async (request) => {
      modelRequests.push(request);
      if (!options.model) {
        throw new Error("No model in this test");
      }
      return await options.model(request);
    },
    openDecision: async (request) => {
      decisions.push(request);
      return {
        link: `https://grasp.test/decisions/${request.step}`,
        eventType: `decision-${request.step}`,
      };
    },
    getState: async (key) => state.get(key),
    setState: async (key, value) => {
      state.set(key, value);
    },
  };

  return { engine, sleeps, waits, modelRequests, decisions, state };
};
