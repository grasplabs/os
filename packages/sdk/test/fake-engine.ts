/* oxlint-disable require-await -- fakes of async interfaces answer right away */
import { runIdSchema } from "@grasp-os/shared/ids";
import { vi } from "vite-plus/test";

import type {
  EngineEvent,
  JsonValue,
  ModelRequest,
  WorkflowEngine,
} from "../src/engine.ts";

/** A workflow's state; pass one to several engines to share it between runs. */
export const createFakeState = () => ({
  values: new Map<string, JsonValue>(),
  appliedWrites: new Set<string>(),
});

interface FakeEngineOptions {
  runId?: string;
  params?: Record<string, unknown>;
  /** Answers the model gateway. */
  model?: (request: ModelRequest) => unknown;
  /** Delivers an event to a wait, or nothing (a timeout). */
  event?: (name: string, options: { type: string }) => EngineEvent;
  state?: ReturnType<typeof createFakeState>;
  /**
   * The first state write lands, then the engine dies before it records the
   * step, as a crash between the two would.
   */
  crashAfterFirstWrite?: boolean;
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
  const state = options.state ?? createFakeState();
  let crashed = false;

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
    runId: runIdSchema.parse(options.runId ?? "run-1"),
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
        const event = options.event?.(name, { type }) ?? { received: false };
        // A wait that times out takes its time; on a fake clock, move it on.
        if (!event.received && timeout !== undefined && vi.isFakeTimers()) {
          vi.setSystemTime(Date.now() + timeout);
        }
        return event;
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
    getState: async (key) => state.values.get(key),
    setState: async (key, value, idempotencyKey) => {
      if (state.appliedWrites.has(idempotencyKey)) {
        return;
      }
      state.appliedWrites.add(idempotencyKey);
      state.values.set(key, value);
      if (options.crashAfterFirstWrite === true && !crashed) {
        crashed = true;
        throw new Error("Engine died before recording the step");
      }
    },
  };

  return { engine, sleeps, waits, modelRequests, decisions, state };
};
