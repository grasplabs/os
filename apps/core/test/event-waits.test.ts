import {
  appIdSchema,
  runIdSchema,
  workflowIdSchema,
} from "@grasp-os/shared/ids";
import { authoritySchema } from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RunHost } from "../src/workflows/host.ts";
import type { HostHooks, RunStep } from "../src/workflows/host.ts";

// A run's wait for an event, against an engine of the test's own on a fake
// clock: the engine is the outside system here, and the clock is what the
// wait's timeout is about. Real runs on the local engine (workflow-chaos
// and workflows tests) cover the rest; they can't stop a run at an exact
// moment of a wait.

/** An event the engine gets at `at` milliseconds. */
interface Delivery {
  at: number;
  type: string;
  id: string;
}

/** How the engine stops an execution it will resume (host.ts). */
const engineStop = "Aborting engine: User called pause";

/**
 * Cloudflare's `step` as far as a wait uses it: steps are recorded by name
 * and replayed from the record, a wait keeps its deadline across
 * executions, and each delivery goes to one wait of its type. With
 * `stopAtCopies` set, it stops the execution when a wait begins to wait
 * again for a copy, as a crash or a deploy may.
 */
const fakeEngine = (deliveries: readonly Delivery[]) => {
  const recorded = new Map<string, { value: unknown } | { error: Error }>();
  const deadlines = new Map<string, number>();
  const taken = new Set<Delivery>();
  const engine = { stopAtCopies: false };
  const replayed = (name: string): { value: unknown } | undefined => {
    const record = recorded.get(name);
    if (record && "error" in record) {
      throw record.error;
    }
    return record;
  };
  const step: RunStep = {
    do: async (name, _config, fn) => {
      const record = replayed(name) ?? { value: await fn() };
      recorded.set(name, record);
      return record.value;
    },
    sleep: async () => {
      await Promise.resolve();
    },
    waitForEvent: async (name, { type, timeout }) => {
      const record = replayed(name);
      if (record) {
        return { payload: record.value };
      }
      if (engine.stopAtCopies && name.startsWith("$grasp:wait:")) {
        throw new Error(engineStop);
      }
      const deadline = deadlines.get(name) ?? Date.now() + Number(timeout);
      deadlines.set(name, deadline);
      const [next] = deliveries
        .filter((event) => !taken.has(event) && event.type === type)
        .filter((event) => event.at <= deadline)
        .toSorted((one, other) => one.at - other.at);
      if (!next) {
        vi.setSystemTime(deadline);
        const error = new Error(`Execution timed out after ${timeout}ms`);
        recorded.set(name, { error });
        throw error;
      }
      taken.add(next);
      vi.setSystemTime(Math.max(Date.now(), next.at));
      const value = { id: next.id, payload: null };
      recorded.set(name, { value });
      return await Promise.resolve({ payload: value });
    },
  };
  return { step, engine };
};

const hooks: HostHooks = {
  stepFailed: () => {},
  engineStopped: () => false,
  waiting: async () => {
    await Promise.resolve();
  },
  goesOn: async () => {
    await Promise.resolve();
  },
  callApp: () => {
    throw new Error("A wait calls no App");
  },
};

/** One execution of a run, on `step`. */
const execution = (step: RunStep): RunHost => {
  const app = appIdSchema.parse("app-waits");
  return new RunHost(
    env,
    step,
    {
      app,
      workflow: workflowIdSchema.parse("waits"),
      version: 1,
      runId: runIdSchema.parse("run-waits"),
      authority: authoritySchema.parse({
        subject: { type: "app", appId: app },
        onBehalfOf: "person-waits",
        mode: "workflow",
        appVersion: 1,
      }),
      connections: {},
    },
    hooks
  );
};

const wait = { type: "go", timeout: 1000 };

describe("waits for an event", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("end at their timeout from when they began, when one passes over a copy after a restart", async () => {
    vi.setSystemTime(0);
    // An event at once, which the first wait takes, and its copy at 900
    // ms, which the second passes over: then nothing more.
    const { step, engine } = fakeEngine([
      { at: 0, type: "go", id: "event" },
      { at: 900, type: "go", id: "event" },
    ]);
    const first = execution(step);
    engine.stopAtCopies = true;
    const taken = await first.waitForEvent("first", wait);
    const stopped = await first.waitForEvent("second", wait);
    const before = {
      first: taken,
      secondEnded: stopped.ok,
      stoppedAt: Date.now(),
    };
    // Restarted at 900 ms: the new execution replays both waits, and the
    // second waits on, for what is left of its 1000 ms.
    engine.stopAtCopies = false;
    const again = execution(step);
    await again.waitForEvent("first", wait);

    expect({
      before,
      second: await again.waitForEvent("second", wait),
      endedAt: Date.now(),
    }).toStrictEqual({
      before: {
        first: { ok: true, value: { received: true, payload: null } },
        secondEnded: false,
        stoppedAt: 900,
      },
      second: { ok: true, value: { received: false } },
      endedAt: 1000,
    });
  });
});
