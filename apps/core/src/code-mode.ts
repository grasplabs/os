import { compatibilityDate } from "@grasp-os/shared/runtime";
import type { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

// Code Mode: the agent acts by writing code against typed APIs, and the
// code runs here, in a Dynamic Worker of its own that is locked down like
// every isolate running code the agent or an App wrote. It has no network
// (`globalOutbound: null`), can't import the parent's env or exports
// (`disallow_importable_env`), and its env holds only the stubs it is
// given: loopback entrypoints of core whose props core sets, never a raw
// binding. What the code returns, logs or throws comes back as data.

/**
 * How far one run may go: CPU time and calls out of the isolate (its stubs)
 * as the runtime counts them, and wall-clock time, which also ends a run
 * that waits forever. Memory is the runtime's per-isolate limit; Worker
 * Loader has no setting for less.
 */
export const codeLimits = {
  cpuMs: 10_000,
  subRequests: 100,
  timeoutMs: 30_000,
  /** Most characters of logs and result that go back to the model. */
  outputChars: 32 * 1024,
} as const;

/**
 * Runs in the isolate: calls the code's default export with the env, and
 * returns its result, its logs and what it threw. An env name the code
 * wasn't given is refused by name, instead of failing later as `undefined`.
 */
const harness = `
import { WorkerEntrypoint } from "cloudflare:workers";
import code from "code.js";

// More than the model reads, so it can be told what was cut; no more, so
// a run can't send core more than that.
const room = ${2 * codeLimits.outputChars};

const tooLarge = new Error("too large");

// A value as text, never much longer than room: serializing stops as soon
// as it would pass it, instead of building all of a huge value first.
const show = (value) => {
  if (typeof value === "string") {
    return value.slice(0, room);
  }
  let size = 0;
  try {
    return (
      JSON.stringify(value, (key, item) => {
        size += key.length + (typeof item === "string" ? item.length : 8);
        if (size > room) {
          throw tooLarge;
        }
        return item;
      }) ?? String(value)
    );
  } catch (error) {
    return error === tooLarge
      ? "(a value too large to show, over " + room + " characters)"
      : String(value).slice(0, room);
  }
};

export default class extends WorkerEntrypoint {
  async run() {
    const logs = [];
    let left = room;
    const write = (...parts) => {
      if (left > 0) {
        const line = parts.map(show).join(" ").slice(0, left);
        left -= line.length + 1;
        logs.push(line);
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
      if (typeof code !== "function") {
        throw new TypeError("The module's default export must be an async function: export default async (env) => { ... }");
      }
      const value = await code(env);
      return {
        ok: true,
        logs,
        result: value === undefined ? undefined : show(value).slice(0, room),
      };
    } catch (error) {
      return {
        ok: false,
        logs,
        error: (error instanceof Error ? (error.stack ?? String(error)) : show(error)).slice(0, room),
      };
    }
  }
}
`;

/**
 * What the isolate sends back. It is the agent's code that runs there, so
 * nothing it returns is trusted as more than text.
 */
const runSchema = z.object({
  ok: z.boolean(),
  logs: z.array(z.string()),
  result: z.string().optional(),
  error: z.string().optional(),
});

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

/**
 * Ends a run that takes too long, or that its caller cancels. Its timer is
 * cleared when the run ends, so none outlives it to keep the object that
 * started the run awake.
 */
const deadline = (caller: AbortSignal | undefined) => {
  const ended = Promise.withResolvers<CodeRun>();
  const cancel = () => {
    ended.resolve(failed("The run was cancelled."));
  };
  const timer = setTimeout(() => {
    ended.resolve(
      failed(
        `The run took longer than ${codeLimits.timeoutMs / 1000} seconds, so it was stopped.`
      )
    );
  }, codeLimits.timeoutMs);
  if (caller?.aborted === true) {
    cancel();
  }
  caller?.addEventListener("abort", cancel, { once: true });
  return {
    ended: ended.promise,
    clear: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", cancel);
    },
  };
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
    compatibilityDate,
    // Without it, `import { env, exports } from "cloudflare:workers"` would
    // reach the isolate's own env and entrypoints around the harness.
    compatibilityFlags: ["disallow_importable_env"],
    mainModule: "harness.js",
    modules: { "harness.js": harness, "code.js": code },
    env,
    globalOutbound: null,
    limits: { cpuMs: codeLimits.cpuMs, subRequests: codeLimits.subRequests },
  });
  const limit = deadline(signal);
  try {
    const outcome: unknown = await Promise.race([
      worker.getEntrypoint<Harness>().run(),
      limit.ended,
    ]);
    const parsed = runSchema.safeParse(outcome);
    return parsed.success
      ? parsed.data
      : failed("The run returned something that isn't a result.");
  } catch (error) {
    // The code didn't load (a syntax error, say), or the runtime stopped
    // it (CPU time, memory). Its message is about the code, never core.
    return failed(error instanceof Error ? error.message : String(error));
  } finally {
    limit.clear();
  }
};

const truncate = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n… (cut: longer than ${max} characters)`;

/** A run as the model reads it: its logs, then its result or error. */
export const describeRun = ({ ok, logs, result, error }: CodeRun): string => {
  const parts = [
    ...(logs.length > 0 ? [`Logs:\n${logs.join("\n")}`] : []),
    ...(ok && result !== undefined ? [`Returned:\n${result}`] : []),
    ...(ok ? [] : [`Error:\n${error ?? "The run failed."}`]),
  ];
  return truncate(
    parts.length === 0 ? "(no logs, returned nothing)" : parts.join("\n\n"),
    codeLimits.outputChars
  );
};
