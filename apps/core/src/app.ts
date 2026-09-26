import { appErrors } from "@grasp-os/shared/apps";
import type { AppCaller } from "@grasp-os/shared/apps";
import {
  isExpectedError,
  messageOf,
  toOpaqueError,
} from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import type { AppErrorEntry } from "@grasp-os/shared/screens";
import { DurableObject } from "cloudflare:workers";

import { appBindings } from "./app-bindings.ts";
import { addToErrorLog, readErrorLog } from "./app-error-log.ts";
import { findApp, versionFiles } from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { requireFeature } from "./features.ts";
import { sandbox } from "./sandbox.ts";
import { buildFailed, buildServer } from "./screens.ts";

// An App's server code runs as a facet of the App's own Durable Object:
// loaded through the Worker Loader from the App's current version, with a
// SQLite database of its own that stays when the code changes. The App is
// code nobody reviewed line by line (the agent writes it), so its isolate
// has no network (`globalOutbound: null`), can't import core's env
// (`disallow_importable_env`), and its env holds only stubs for the App's
// active permissions (app-bindings.ts), never one of core's own bindings.
//
// One App serves everyone who uses it, at the same time. So its stubs act
// for no one on their own: every call into the App gets a caller from core
// (from the session, or the workflow run), with a token only this object
// knows, for as long as the call runs. The App passes the caller on to its
// stubs, which ask this object who the token belongs to. App code has no
// way to name a person itself, and a token it keeps stops working once its
// call ends.

/** The facet the App's server code runs in. */
const facetName = "server";

/**
 * How long one call may take in all, starting the code and waiting
 * included, before the host gives up on it: its caller gets
 * `app.timed_out`, and its token stops working, so a call that never ends
 * can't keep acting for its caller. Tests shorten it with
 * `APP_CALL_TIMEOUT_MS`; it is never set in wrangler.jsonc.
 */
const defaultCallTimeoutMs = 60_000;

const callTimeoutMs = (env: Env): number => {
  const set = Number(env.APP_CALL_TIMEOUT_MS);
  return Number.isInteger(set) && set > 0 && set < defaultCallTimeoutMs
    ? set
    : defaultCallTimeoutMs;
};

/**
 * A method App code exports: an identifier, and not one the Durable Object
 * runtime, RPC or `Object` gives a meaning of its own. A name on the facet
 * stub's prototype chain is refused too (see `call`).
 */
const methodName = /^[a-z][A-Za-z0-9]{0,63}$/u;
const reservedMethods = new Set([
  "alarm",
  "connect",
  "constructor",
  "delete",
  "dup",
  "fetch",
  "get",
  "hasOwnProperty",
  "id",
  "isPrototypeOf",
  "name",
  "propertyIsEnumerable",
  "put",
  "queue",
  "scheduled",
  "then",
  "toLocaleString",
  "toString",
  "valueOf",
  "webSocketClose",
  "webSocketError",
  "webSocketMessage",
]);

/** Where the host counts starts on new code or permissions (`#load`, `restart`). */
const generationKey = "generation";

/** Where the host keeps the version its code last started on. */
const versionKey = "version";

/**
 * The names of the runtime's own errors, safe to log. Any other name was
 * made up by App code, and may hold anything.
 */
const runtimeErrorNames = new Set([
  "AbortError",
  "DataCloneError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "URIError",
]);

/** An error's name for the log: the runtime's, or `custom` for App-made ones. */
const errorNameOf = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return typeof error;
  }
  return runtimeErrorNames.has(error.name) ? error.name : "custom";
};

/** Where the App keeps its restricted mode (see restricted.ts). */
const restrictedKey = "restricted";

/**
 * Where the App keeps its workflows' state, by workflow and key, and the
 * idempotency keys of the writes it applied. Workflow IDs and state keys
 * have no `:`, so no two of them share a storage key.
 */
const workflowStatePrefix = "workflow-state:";
const workflowWritePrefix = "workflow-write:";

/**
 * What an App method answers: plain data, as structured clone carries it.
 * Never a stub, a function or an RpcTarget: an answer goes on to screens
 * and workflows, and must not hand them a way into the App.
 */
export type AppAnswer = Rpc.Serializable<unknown>;

/** Whether a value is plain data, as structured clone carries it. */
export const isPlainData = (value: unknown): boolean => {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

/** `answer`, if it is plain data; `app.answer_invalid` if not. */
const plainAnswer = (
  answer: AppAnswer,
  version: number,
  method: string
): AppAnswer => {
  if (!isPlainData(answer)) {
    throw appErrors.create("app.answer_invalid", { version, method });
  }
  return answer;
};

/**
 * A method of the facet's stub. Every name on an RPC stub is a function
 * that calls the method of that name, so this only rules out the few that
 * aren't (`then`, symbols).
 */
const isMethod = (
  value: unknown
): value is (...args: unknown[]) => Promise<AppAnswer> =>
  typeof value === "function";

/** Who calls the App, as core knows it; the token is the host's. */
export type AppCallerInput = Omit<AppCaller, "token">;

/** The App's current version: the one that runs. */
const currentVersion = async (env: Env, app: AppId): Promise<number> => {
  const { currentVersion: version } = await findApp(env, app);
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  return version;
};

/**
 * The App's server code at `version`, with an env for the permissions of
 * `generation` (see `#load`), as the class its facet runs.
 */
const loadServer = async (
  env: Env,
  app: AppId,
  version: number,
  generation: number
): Promise<DurableObjectClass> => {
  const files = await versionFiles(env, app, version);
  const build = await buildServer(env, {
    app,
    version: String(version),
    files,
  });
  if (!build.ok) {
    throw appErrors.create("app.build_failed", buildFailed(version, build));
  }
  const bindings = await appBindings(env, app);
  // The same generation has the same key, so the loader may keep its
  // isolate while the host sleeps. Another version, or a grant or revoke
  // (a new generation), starts a new one.
  const key = `app:${app}:${version}:${generation}`;
  return env.LOADER.get(key, () => ({
    ...sandbox,
    mainModule: build.mainModule,
    modules: build.modules,
    env: bindings,
  })).getDurableObjectClass("App");
};

/** An error as a caller of the App may see it: ours, or `internal.unexpected`. */
const forCaller = (
  error: unknown,
  app: AppId,
  version: number | undefined,
  method: string
): Error => {
  if (!isExpectedError(error)) {
    log.error("app.call_error", {
      appId: app,
      version,
      method,
      errorName: errorNameOf(error),
    });
  }
  return toOpaqueError(error, { version: version ?? null });
};

/**
 * One App: the host of its server code (`app/server.ts`, exporting an
 * `App` class), and the keeper of its restricted mode (restricted.ts).
 * Core reaches it through `callApp`; the App's own code reaches it only
 * through its stubs.
 */
export class App extends DurableObject<Env> {
  /**
   * The code the facet runs: its version, which read of the current
   * version chose it (see `#facet`), and its class once loaded.
   */
  #server:
    | { version: number; read: number; loaded: Promise<DurableObjectClass> }
    | undefined;

  /** How many times a call has read the current version. */
  #reads = 0;

  /**
   * The calls running now, by token, with the version their code runs on
   * once it started.
   */
  readonly #calls = new Map<string, AppCallerInput & { version?: number }>();

  get #app(): AppId {
    return appIdSchema.parse(this.ctx.id.name);
  }

  /**
   * Calls `method` of the App's server code with `args`, for `caller`,
   * who comes first in the arguments the method gets. Runs the App's
   * current version, restarting the code on it when another was running.
   * Answers plain data only.
   *
   * A call that isn't answered in time gets `app.timed_out`, and its
   * caller stops working at once. The App's code keeps running for the
   * other calls: it is one facet, shared by them all.
   */
  async call(
    caller: AppCallerInput,
    method: string,
    args: unknown[]
  ): Promise<AppAnswer> {
    if (!methodName.test(method) || reservedMethods.has(method)) {
      throw appErrors.create("app.method_invalid", { method });
    }
    const token = crypto.randomUUID();
    this.#calls.set(token, caller);
    let version: number | undefined;
    const run = async (): Promise<AppAnswer> => {
      const read = this.#nextRead();
      const running = await this.#facet(
        await currentVersion(this.env, this.#app),
        read
      );
      ({ version } = running);
      // Timed out while the code started: its caller already has the
      // answer, so the method mustn't run (and write) after all.
      if (!this.#calls.has(token)) {
        throw appErrors.create("app.timed_out", { version, method });
      }
      // What the App's stub calls in this call are audited with.
      this.#calls.set(token, { ...caller, version });
      // Only the App's own methods: not what every stub has.
      if (method in Object.getPrototypeOf(running.facet)) {
        throw appErrors.create("app.method_invalid", { method });
      }
      const invoke: unknown = Reflect.get(running.facet, method);
      if (!isMethod(invoke)) {
        throw appErrors.create("app.method_invalid", { method });
      }
      let answer: AppAnswer;
      try {
        // Not `invoke.apply(...)`: on a stub, that calls a method "apply".
        answer = await Reflect.apply(invoke, running.facet, [
          { ...caller, token } satisfies AppCaller,
          ...args,
        ]);
      } catch (error) {
        throw this.#reported(error, running.version, method);
      }
      return plainAnswer(answer, running.version, method);
    };

    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      deadline.reject(new Error("Timed out"));
    }, callTimeoutMs(this.env));
    // Never rejects: when the deadline wins, the call goes on without a
    // caller, and how it ends is nobody's business any more.
    const settled = async (): Promise<
      { answer: AppAnswer } | { error: unknown }
    > => {
      try {
        return { answer: await run() };
      } catch (error) {
        return { error };
      }
    };
    let outcome: { answer: AppAnswer } | { error: unknown };
    try {
      outcome = await Promise.race([settled(), deadline.promise]);
    } catch {
      throw appErrors.create("app.timed_out", {
        version: version ?? null,
        method,
      });
    } finally {
      clearTimeout(timer);
      this.#calls.delete(token);
    }
    if ("error" in outcome) {
      throw forCaller(outcome.error, this.#app, version, method);
    }
    return outcome.answer;
  }

  /** Whether the App has read restricted data. */
  async isRestricted(): Promise<boolean> {
    return (await this.ctx.storage.get(restrictedKey)) === true;
  }

  /** Puts the App in restricted mode, for good. */
  async restrict(): Promise<void> {
    await this.ctx.storage.put(restrictedKey, true);
  }

  /** Adds an entry to the App's error log (app-error-log.ts). */
  async logError(entry: AppErrorEntry): Promise<void> {
    await addToErrorLog(this.ctx.storage, entry);
  }

  /** The App's error log, newest first. */
  async errors(): Promise<AppErrorEntry[]> {
    return await readErrorLog(this.ctx.storage);
  }

  /**
   * A value of the App's workflow `workflow`'s state, shared by all its
   * runs (`state.get` in workflow code, through workflows/host.ts): JSON
   * text, as the host checked it when it was written, or undefined.
   */
  async workflowState(
    workflow: string,
    key: string
  ): Promise<string | undefined> {
    return await this.ctx.storage.get<string>(
      `${workflowStatePrefix}${workflow}:${key}`
    );
  }

  /**
   * Writes a value of workflow `workflow`'s state, once per idempotency
   * key: a write a run repeats after a crash is ignored, so it can't
   * overwrite a newer value. The check and the write happen together,
   * as nothing else runs in this object between them.
   */
  async setWorkflowState(
    workflow: string,
    run: string,
    key: string,
    json: string,
    idempotencyKey: string
  ): Promise<void> {
    const write = `${workflowWritePrefix}${workflow}:${run}:${idempotencyKey}`;
    if ((await this.ctx.storage.get(write)) !== undefined) {
      return;
    }
    await this.ctx.storage.put({
      [write]: true,
      [`${workflowStatePrefix}${workflow}:${key}`]: json,
    });
  }

  /**
   * Forgets the writes run `run` applied, once it has ended: an ended run
   * is never replayed, so its writes can't come again.
   */
  async forgetWorkflowWrites(workflow: string, run: string): Promise<void> {
    const writes = await this.ctx.storage.list({
      prefix: `${workflowWritePrefix}${workflow}:${run}:`,
    });
    const keys = [...writes.keys()];
    // Storage deletes at most 128 keys at a time.
    for (let start = 0; start < keys.length; start += 128) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time
      await this.ctx.storage.delete(keys.slice(start, start + 128));
    }
  }

  /**
   * Who a stub call acts for: the caller of the running call `token`
   * names, with the version of the code the call runs, and, for a
   * workflow run's step, that step's idempotency key. For the App's stubs
   * (app-bindings.ts) only. A call whose code hasn't started has handed
   * its token to no one, so no stub call can come with it.
   */
  callerOf(token: string): {
    authority: Authority;
    idempotencyKey: string | undefined;
  } {
    const caller = this.#calls.get(token);
    if (caller?.version === undefined) {
      throw appErrors.create("app.caller_invalid");
    }
    return {
      authority: {
        subject: { type: "app", appId: this.#app },
        onBehalfOf: caller.userId,
        mode: caller.mode,
        appVersion: caller.version,
      },
      idempotencyKey: caller.idempotencyKey,
    };
  }

  /**
   * Stops the App's server code after its permissions changed: the next
   * call starts it again in a new isolate, with an env as the permissions
   * are then. Calls running now fail.
   */
  async restart(reason: string): Promise<void> {
    await this.ctx.storage.put(generationKey, (await this.#generation()) + 1);
    this.#stop(reason);
  }

  async #generation(): Promise<number> {
    return (await this.ctx.storage.get<number>(generationKey)) ?? 0;
  }

  #stop(reason: string): void {
    this.#server = undefined;
    this.ctx.facets.abort(facetName, new Error(reason));
  }

  #nextRead(): number {
    this.#reads += 1;
    return this.#reads;
  }

  /**
   * The class for `version`. A version other than the one that ran last
   * (a release, or a rollback to one that ran before) is a new generation
   * too, so no isolate an earlier run of it kept warm comes back with its
   * memory. Only a host that woke up on the same code reuses one.
   */
  async #load(version: number): Promise<DurableObjectClass> {
    let generation = await this.#generation();
    if ((await this.ctx.storage.get<number>(versionKey)) !== version) {
      generation += 1;
      await this.ctx.storage.put({
        [generationKey]: generation,
        [versionKey]: version,
      });
    }
    return await loadServer(this.env, this.#app, version, generation);
  }

  /**
   * The facet, running the version `read` found current: started, or
   * restarted from another. Calls read the current version at the same
   * time, so a read that started earlier can come back later with an
   * older version: the code a later read chose stays, and the call runs
   * on it.
   */
  async #facet(
    version: number,
    read: number
  ): Promise<{ facet: Fetcher; version: number }> {
    let server = this.#server;
    // Unknown after this object started, so the facet is restarted then
    // too: aborting one that isn't running changes nothing.
    if (!server || (server.version !== version && read > server.read)) {
      this.#stop(`Version ${version} is now current.`);
      server = { version, read, loaded: this.#load(version) };
      this.#server = server;
    } else if (server.version === version) {
      server.read = Math.max(server.read, read);
    }
    let loaded: DurableObjectClass;
    try {
      loaded = await server.loaded;
    } catch (error) {
      if (this.#server === server) {
        this.#server = undefined;
      }
      throw error;
    }
    // Replaced meanwhile, by a newer read or a restart.
    if (this.#server !== server) {
      const now = this.#server ?? server;
      return await this.#facet(now.version, now.read);
    }
    const facet = this.ctx.facets.get(facetName, () => ({
      class: loaded,
      id: facetName,
    }));
    return { facet, version: server.version };
  }

  /**
   * An error of the App's code as its caller gets it: `app.failed`, with
   * the version that ran and the App's own message, never a stack or a
   * code the App made up. The log gets no App-written text: only which
   * App, version and method, and the error's name.
   */
  #reported(error: unknown, version: number, method: string): Error {
    log.warn("app.call_failed", {
      appId: this.#app,
      version,
      method,
      errorName: errorNameOf(error),
    });
    const reported = appErrors.create("app.failed", {
      version,
      method,
      message: messageOf(error),
    });
    reported.stack = undefined;
    return reported;
  }
}

/**
 * Calls a method of an App's server code for `caller`: a person in a
 * session (screens), or the person a workflow run acts for. Core takes the
 * caller from the session or the run, never from the request. Anything
 * that fails outside the App's own errors comes back as
 * `internal.unexpected`. Refused while `apps` is switched off: screens
 * and workflows alike call Apps only through here.
 */
export const callApp = async (
  env: Env,
  app: AppId,
  caller: AppCallerInput,
  method: string,
  args: unknown[] = []
): Promise<AppAnswer> => {
  requireFeature(env, "apps");
  try {
    return await appHost(env, app).call(caller, method, args);
  } catch (error) {
    throw forCaller(error, app, undefined, method);
  }
};
