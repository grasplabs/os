import type { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import { deadline } from "./deadline.ts";
import { sandbox } from "./sandbox.ts";

// Code Mode: the agent acts by writing code against typed APIs, and the
// code runs here, in a Dynamic Worker of its own, locked down like App code
// (sandbox.ts): no network (`globalOutbound: null`), no importable env or
// exports (`disallow_importable_env`), the same CPU limit per run, and on
// top a cap on its calls out. It has no Cache API (a cache shared between
// runs would let one chat hand data to another), and its env holds only
// the stubs it is given: loopback entrypoints of core whose props core
// sets, never a raw binding. What the code returns, logs or throws comes
// back as data, and core bounds it again: the code runs in the same
// isolate as the harness, so nothing the harness does is trusted.
//
// The CPU limit is enforced by Cloudflare's runtime, not by plain workerd.
// On-prem (plain workerd) the `agent` feature stays off: without that
// limit a run could spin forever.

/**
 * How far one run may go beyond App code's CPU limit: calls out of the
 * isolate (its API calls, which the Workspace object counts on every call,
 * `callFromCodeRun`; the runtime's own cap too, where it enforces one:
 * plain workerd doesn't), and wall-clock time, which also ends a run that
 * waits forever. Memory is the runtime's per-isolate limit; Worker Loader
 * has no setting for less.
 */
export const codeLimits = {
  subRequests: 100,
  timeoutMs: 30_000,
  /** Most characters of logs and result that go back to the model. */
  outputChars: 32 * 1024,
  /** Most log lines a run may send back. */
  logLines: 1000,
} as const;

/**
 * Most characters of each part of a run that core takes from the isolate:
 * more than the model reads, so it can be told what was cut.
 */
const room = 2 * codeLimits.outputChars;

/**
 * Runs in the isolate: takes what it needs of the language first, removes
 * the Cache API, and only then loads the code, which can't change what the
 * harness already holds. Calls the code's default export with the env, and
 * returns its result, its logs and what it threw. An env name the code
 * wasn't given is refused by name, instead of failing later as `undefined`.
 */
const harness = `
import { WorkerEntrypoint } from "cloudflare:workers";

const room = ${room};
const lines = ${codeLimits.logLines};
const slice = Function.prototype.call.bind(String.prototype.slice);
const stringify = JSON.stringify;
const toText = String;
const push = Function.prototype.call.bind(Array.prototype.push);
const tooLarge = new Error("too large");

Object.defineProperty(globalThis, "caches", { value: undefined });

// A value as text: serializing stops as soon as it would pass room,
// instead of building all of a huge value first.
const render = (value) => {
  if (typeof value === "string") {
    return value;
  }
  let size = 0;
  try {
    return (
      stringify(value, (key, item) => {
        size += key.length + (typeof item === "string" ? item.length : 8);
        if (size > room) {
          throw tooLarge;
        }
        return item;
      }) ?? toText(value)
    );
  } catch (error) {
    return error === tooLarge
      ? "(a value too large to show, over " + room + " characters)"
      : toText(value);
  }
};

// Never longer than room, whatever the value makes of itself (a
// \`toString\` of its own, say).
const show = (value) => slice(toText(render(value)), 0, room);

export default class extends WorkerEntrypoint {
  async run() {
    const logs = [];
    let left = room;
    const write = (...parts) => {
      if (left > 0 && logs.length < lines) {
        let line = "";
        for (const part of parts) {
          line = line === "" ? show(part) : line + " " + show(part);
        }
        line = slice(line, 0, left);
        left -= line.length + 1;
        push(logs, line);
      }
    };
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      console[level] = write;
    }
    const given = Object.keys(this.env);
    const env = new Proxy(this.env, {
      get(target, name) {
        if (typeof name === "string" && name !== "then" && !(name in target)) {
          throw new Error(
            "This chat has no API named env." + name + ". It has: " +
              (given.length === 0 ? "none" : given.map((api) => "env." + api).join(", ")) + "."
          );
        }
        return target[name];
      },
    });
    try {
      const { default: code } = await import("code.js");
      if (typeof code !== "function") {
        throw new TypeError("The module's default export must be an async function: export default async (env) => { ... }");
      }
      const value = await code(env);
      // An own \`then\`, so an \`Object.prototype.then\` the code set can't
      // make the result a thenable that resolves to something else.
      return { then: undefined, ok: true, logs, result: value === undefined ? undefined : show(value) };
    } catch (error) {
      return {
        then: undefined,
        ok: false,
        logs,
        error: error instanceof Error ? show(error.stack ?? toText(error)) : show(error),
      };
    }
  }
}
`;

/**
 * What the isolate sends back, bounded here whatever the harness did: the
 * agent's code runs in the same isolate and can change anything there.
 */
const runSchema = z
  .object({
    ok: z.boolean(),
    logs: z.array(z.string().max(room)).max(codeLimits.logLines),
    result: z.string().max(room).optional(),
    error: z.string().max(room).optional(),
  })
  // All of it: the logs share one room, the result or error has another.
  .refine(
    ({ logs, result, error }) =>
      logs.reduce((total, line) => total + line.length, 0) +
        (result?.length ?? 0) +
        (error?.length ?? 0) <=
      2 * room,
    { message: "More than a run may send back" }
  );

/** One run of the agent's code. */
export type CodeRun = z.infer<typeof runSchema>;

/**
 * The harness's entrypoint, as core calls it. What it says it returns is
 * checked, not trusted.
 */
interface Harness extends WorkerEntrypoint {
  run: () => Promise<CodeRun>;
}

const failed = (error: string): CodeRun => ({ ok: false, logs: [], error });

/** A run that was stopped, as it ends: when the deadline passes. */
const stoppedRun = async (signal: AbortSignal): Promise<never> => {
  const stopped = Promise.withResolvers<never>();
  const stop = () => {
    stopped.reject(signal.reason);
  };
  if (signal.aborted) {
    stop();
  }
  signal.addEventListener("abort", stop, { once: true });
  try {
    return await stopped.promise;
  } finally {
    signal.removeEventListener("abort", stop);
  }
};

/**
 * Runs `code`, an ES module whose default export is an async function of
 * `env`, in a fresh locked isolate with `env` as its only way out. Never
 * throws: code that fails to load, throws, runs out of time or is
 * cancelled comes back as a failed run.
 */
export const runCode = async (
  loader: WorkerLoader,
  code: string,
  env: Readonly<Record<string, Fetcher>>,
  signal?: AbortSignal
): Promise<CodeRun> => {
  const worker = loader.load({
    ...sandbox,
    mainModule: "harness.js",
    modules: { "harness.js": harness, "code.js": code },
    env,
    limits: { ...sandbox.limits, subRequests: codeLimits.subRequests },
  });
  const limit = deadline(codeLimits.timeoutMs, signal);
  try {
    const outcome: unknown = await Promise.race([
      worker.getEntrypoint<Harness>().run(),
      stoppedRun(limit.signal),
    ]);
    const parsed = runSchema.safeParse(outcome);
    return parsed.success
      ? parsed.data
      : failed("The run returned more than it may, or not a result.");
  } catch (error) {
    if (limit.stopped() === "cancelled") {
      return failed("The run was cancelled.");
    }
    if (limit.stopped() === "timeout") {
      return failed(
        `The run took longer than ${codeLimits.timeoutMs / 1000} seconds, so it was stopped.`
      );
    }
    // The code didn't load (a syntax error, say), or the runtime stopped
    // it (CPU time, memory). Its message is about the code, never core.
    return failed(
      (error instanceof Error ? error.message : String(error)).slice(0, room)
    );
  } finally {
    limit.clear();
  }
};

/**
 * A run as the model reads it: its logs, then its result or error, at most
 * `outputChars` of it. Built only that far, however much the run sent.
 */
export const describeRun = ({ ok, logs, result, error }: CodeRun): string => {
  const max = codeLimits.outputChars;
  let text = "";
  // One character past `max` at most: enough to know it was cut.
  const add = (piece: string) => {
    text += piece.slice(0, Math.max(0, max + 1 - text.length));
  };
  const part = (title: string, lines: readonly string[]) => {
    add(text === "" ? `${title}:` : `\n\n${title}:`);
    for (const line of lines) {
      add(`\n${line}`);
    }
  };
  if (logs.length > 0) {
    part("Logs", logs);
  }
  if (ok && result !== undefined) {
    part("Returned", [result]);
  }
  if (!ok) {
    part("Error", [error ?? "The run failed."]);
  }
  if (text === "") {
    return "(no logs, returned nothing)";
  }
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (cut: longer than ${max} characters)`;
};
