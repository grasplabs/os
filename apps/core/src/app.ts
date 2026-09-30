import {
  appErrors,
  appMethodPattern,
  reservedAppMethods,
} from "@grasp-os/shared/apps";
import type { AppCaller } from "@grasp-os/shared/apps";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import {
  isExpectedError,
  messageOf,
  toOpaqueError,
} from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { log } from "@grasp-os/shared/log";
import type { Authority } from "@grasp-os/shared/permissions";
import type {
  AppErrorEntry,
  RunChange,
  ServerLog,
} from "@grasp-os/shared/screens";
import {
  statisticErrors,
  statisticLimitsOf,
} from "@grasp-os/shared/statistics";
import type { StatisticUse } from "@grasp-os/shared/statistics";
import { DurableObject, exports } from "cloudflare:workers";

import { appBindings } from "./app-bindings.ts";
import { addToErrorLog, readErrorLog } from "./app-error-log.ts";
import { findApp, versionFiles } from "./apps.ts";
import { appHost } from "./durable-objects.ts";
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
// (from the session, the workflow run, or another App's call of one of its
// exports, app-calls.ts), with a token only this object
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

export const callTimeoutMs = (env: Env): number => {
  const set = Number(env.APP_CALL_TIMEOUT_MS);
  return Number.isInteger(set) && set > 0 && set < defaultCallTimeoutMs
    ? set
    : defaultCallTimeoutMs;
};

/**
 * A method App code exports: an identifier, and not one the Durable Object
 * runtime, RPC or `Object` gives a meaning of its own (shared with the
 * workflow SDK's typed stub of the App). A name on the facet stub's
 * prototype chain is refused too (see `call`).
 */
const reservedMethods: ReadonlySet<string> = new Set(reservedAppMethods);

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
  version: number | null,
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

/**
 * Refuses a method name core never calls on App code: not an identifier,
 * or one the runtime gives a meaning of its own (`reservedMethods`).
 */
export const requireAppMethod = (method: string): void => {
  if (!appMethodPattern.test(method) || reservedMethods.has(method)) {
    throw appErrors.create("app.method_invalid", { method });
  }
};

/** Which App's code a call ran: its version (null for a draft's), and method. */
interface RanAt {
  app: AppId;
  version: number | null;
  method: string;
}

/**
 * An error of an App's code as its caller gets it: `app.failed`, with the
 * version that ran and the App's own message, never a stack or a code the
 * App made up. The log gets no App-written text: only which App, version
 * and method, and the error's name.
 */
const appFailure = (error: unknown, { app, version, method }: RanAt): Error => {
  log.warn("app.call_failed", {
    appId: app,
    version: version ?? undefined,
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
};

/**
 * Calls `method` of the App's server code running in `facet`, with
 * `caller` first in its arguments: only the App's own methods, never what
 * every stub has, and only plain data back. An error of the App's code
 * comes back as `app.failed`; `failedWith`, if given, sees the error as
 * the App's code threw it first, for core's own use (a draft's preview,
 * preview.ts), never its caller's.
 */
export const invokeServer = async (
  facet: Fetcher,
  caller: AppCaller,
  args: unknown[],
  at: RanAt,
  failedWith?: (error: unknown) => void
): Promise<AppAnswer> => {
  const { method, version } = at;
  if (method in Object.getPrototypeOf(facet)) {
    throw appErrors.create("app.method_invalid", { method });
  }
  const invoke: unknown = Reflect.get(facet, method);
  if (!isMethod(invoke)) {
    throw appErrors.create("app.method_invalid", { method });
  }
  let answer: AppAnswer;
  try {
    // Not `invoke.apply(...)`: on a stub, that calls a method "apply".
    answer = await Reflect.apply(invoke, facet, [caller, ...args]);
  } catch (error) {
    failedWith?.(error);
    throw appFailure(error, at);
  }
  return plainAnswer(answer, version, method);
};

/**
 * A screen's callback for its App's run changes, as the host keeps it:
 * screens-rpc.ts wraps it, checking before each push that the person may
 * still use the App.
 */
export type RunWatcher = Rpc.Stub<(change: RunChange) => Promise<void>>;

/**
 * Who calls the App, as core knows it; the token is the host's. For a
 * workflow run's step, also which attempt of the step the call comes from
 * (`attempt`, the run's engine's ID for it): kept by the host, for the
 * statistics points the call records (statistics.ts), and never shown to
 * the App's code.
 */
export type AppCallerInput = Omit<AppCaller, "token"> & { attempt?: string };

/**
 * What a call from another App's code through an export carries besides
 * its caller (app-calls.ts), for the host to keep with the call: never
 * shown to the App's code.
 */
export interface ExportCall {
  /**
   * The version whose exports core checked the call against: it runs only
   * on that version, and is refused with `app.conflict` once another is
   * current.
   */
  version: number;
  /** The Apps whose calls are under way above this one, outermost first. */
  chain: readonly AppId[];
  /** When the call it comes from must end, in milliseconds since the epoch. */
  deadline: number;
  /** Whether the call may only call other Apps' exports marked `read`. */
  readOnly: boolean;
  /**
   * Called once the call is pinned to `version`, just before the method
   * runs: where the caller records the call (app-calls.ts). If it
   * throws, the method doesn't run.
   */
  onPinned: () => Promise<void>;
}

/**
 * Where a running call is within calls between Apps, as its stubs call
 * other Apps' exports from it (app-calls.ts).
 */
export interface CallPath {
  /** The Apps whose calls are under way, outermost first, this one last. */
  chain: AppId[];
  /** When the call must end, in milliseconds since the epoch. */
  deadline: number;
  /** Whether it may only call other Apps' exports marked `read`. */
  readOnly: boolean;
}

/** A call running now, as the host keeps it by its token. */
interface RunningCall {
  caller: AppCallerInput;
  /** The method of the App's server code it calls. */
  method: string;
  /** Statistics points it recorded and reads it made (`claimStatistic`). */
  statistics?: { point: number; read: number };
  /** The version its code runs on, once started. */
  version?: number;
  /** The Apps whose calls are under way above it, outermost first. */
  above: readonly AppId[];
  deadline: number;
  readOnly: boolean;
}

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
  const build = await buildServer(env, files);
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
    // What its code writes with `console` goes to its error log.
    tails: [exports.AppTail({ props: { app, version } })],
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

  /** Screens following the App's runs, by workflow and ID (`watchRuns`). */
  readonly #runWatchers = new Map<string, Map<string, RunWatcher>>();

  /**
   * The calls running now, by token, with the version their code runs on
   * once it started, and where each runs within calls between Apps.
   */
  readonly #calls = new Map<string, RunningCall>();

  /** Statistics points the App recorded, and reads, in the current minute. */
  #statisticsMinute = { minute: 0, point: 0, read: 0 };

  /** The minute a read refused past its bounds was last audited. */
  #limitedAuditMinute = -1;

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
   *
   * A call from another App's code through an export (`via`, from
   * app-calls.ts) runs only on the version core checked it against, ends
   * by the time the call it came from must, and is kept with the Apps
   * above it, for the calls its code makes on (`callerOf`).
   */
  async call(
    caller: AppCallerInput,
    method: string,
    args: unknown[],
    via?: ExportCall
  ): Promise<AppAnswer> {
    requireAppMethod(method);
    const ms = Math.min(
      callTimeoutMs(this.env),
      (via?.deadline ?? Number.POSITIVE_INFINITY) - Date.now()
    );
    if (ms <= 0) {
      throw appErrors.create("app.timed_out", { version: null, method });
    }
    const token = crypto.randomUUID();
    const { attempt: _attempt, ...shown } = caller;
    const call: RunningCall = {
      caller,
      method,
      above: via?.chain ?? [],
      deadline: Date.now() + ms,
      readOnly: via?.readOnly ?? false,
    };
    this.#calls.set(token, call);
    let version: number | undefined;
    const run = async (): Promise<AppAnswer> => {
      const read = this.#nextRead();
      const current = await currentVersion(this.env, this.#app);
      // The exports checked were another version's: it isn't called.
      if (via !== undefined && current !== via.version) {
        throw appErrors.create("app.conflict");
      }
      const running = await this.#facet(current, read);
      ({ version } = running);
      if (via !== undefined) {
        await this.#pinned(running.version, via);
      }
      // Timed out while the code started: its caller already has the
      // answer, so the method mustn't run (and write) after all.
      if (!this.#calls.has(token)) {
        throw appErrors.create("app.timed_out", { version, method });
      }
      // What the App's stub calls in this call are audited with.
      this.#calls.set(token, { ...call, version });
      return await invokeServer(
        running.facet,
        { ...shown, token } satisfies AppCaller,
        args,
        { app: this.#app, version: running.version, method }
      );
    };

    const limit = deadline(ms);
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
      outcome = await Promise.race([settled(), whenAborted(limit.signal)]);
    } catch {
      throw appErrors.create("app.timed_out", {
        version: version ?? null,
        method,
      });
    } finally {
      limit.clear();
      this.#calls.delete(token);
    }
    if ("error" in outcome) {
      throw forCaller(outcome.error, this.#app, version, method);
    }
    return outcome.answer;
  }

  /**
   * Pins a call from another App's export to the version core checked it
   * against (`via.version`): the facet `#facet` handed back must run it,
   * then the caller hears it is about to run (`via.onPinned`, which
   * records the call), and the facet must still be that version's after:
   * a call that made another version current meanwhile, and started it,
   * would otherwise have this call run code nobody checked it against.
   * Nothing awaits between this and invoking the method, so no other call
   * can replace the facet in between. `app.conflict` otherwise.
   */
  async #pinned(running: number, via: ExportCall): Promise<void> {
    if (running !== via.version) {
      throw appErrors.create("app.conflict");
    }
    await via.onPinned();
    if (this.#server?.version !== via.version) {
      throw appErrors.create("app.conflict");
    }
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
    await addToErrorLog(this.ctx.storage, [entry]);
  }

  /**
   * Adds what the App's server code at `version` wrote with `console` to
   * its error log: for its tail alone (server-logs.ts).
   */
  async logServer(version: number, logs: ServerLog[]): Promise<void> {
    await addToErrorLog(
      this.ctx.storage,
      logs.map((line) => ({ ...line, source: "server", version }))
    );
  }

  /** The App's error log, newest first. */
  async errors(): Promise<AppErrorEntry[]> {
    return await readErrorLog(this.ctx.storage);
  }

  /**
   * Keeps `onChange`, a screen's callback, and calls it each time a run of
   * the App's workflow `workflow` changes (`runChanged`), until calling it
   * fails: the screen is gone, or the person may no longer use the App.
   * Kept here in memory, outside the App's code, so a restart of that code
   * keeps them; a restart of this object drops them, which tells each
   * screen to follow again. Returns the ID `unwatchRuns` drops it by.
   */
  watchRuns(workflow: string, onChange: RunWatcher): string {
    const id = crypto.randomUUID();
    const watchers =
      this.#runWatchers.get(workflow) ?? new Map<string, RunWatcher>();
    watchers.set(id, onChange.dup());
    this.#runWatchers.set(workflow, watchers);
    return id;
  }

  /** Drops the screen's callback `watchRuns` kept as `id`, if it still does. */
  unwatchRuns(workflow: string, id: string): void {
    this.#drop(workflow, id);
  }

  /**
   * Tells the screens following `workflow` that its run `run` changed, so
   * they read it again (workflows/run-changes.ts). Returns at once: each
   * push goes on by itself, and one that fails drops only its screen.
   */
  runChanged(workflow: string, run: string): void {
    for (const [id, watcher] of this.#runWatchers.get(workflow) ?? []) {
      void this.#tell(workflow, id, watcher, { run });
    }
  }

  async #tell(
    workflow: string,
    id: string,
    watcher: RunWatcher,
    change: RunChange
  ): Promise<void> {
    try {
      await watcher(change);
    } catch {
      this.#drop(workflow, id);
    }
  }

  #drop(workflow: string, id: string): void {
    const watchers = this.#runWatchers.get(workflow);
    const watcher = watchers?.get(id);
    watchers?.delete(id);
    if (watchers?.size === 0) {
      this.#runWatchers.delete(workflow);
    }
    watcher?.[Symbol.dispose]();
  }

  /**
   * Who a stub call acts for: the caller of the running call `token`
   * names, with the version of the code the call runs, and, for a
   * workflow run's step, that step's idempotency key and its attempt, and where the call
   * is within calls between Apps (`path`), and the method it calls,
   * which a record's kept fields go by (knowledge/records.ts). For the
   * App's stubs (app-bindings.ts, app-calls.ts) only. A call whose code
   * hasn't started has handed its token to no one, so no stub call can
   * come with it.
   */
  callerOf(token: string): {
    authority: Authority;
    idempotencyKey: string | undefined;
    attempt: string | undefined;
    path: CallPath;
    method: string;
  } {
    const call = this.#calls.get(token);
    if (call?.version === undefined) {
      throw appErrors.create("app.caller_invalid");
    }
    const { caller, method, version, above, deadline: ends, readOnly } = call;
    return {
      authority: {
        subject: { type: "app", appId: this.#app },
        onBehalfOf: caller.userId,
        mode: caller.mode,
        appVersion: version,
      },
      idempotencyKey: caller.idempotencyKey,
      attempt: caller.attempt,
      path: { chain: [...above, this.#app], deadline: ends, readOnly },
      method,
    };
  }

  /**
   * Counts one statistics `use` (a point recorded, or a read) of the
   * running call `token` names, for the App's stubs
   * (statistics-binding.ts), and answers who the call acts for as
   * `callerOf` does: at most the use's bounds (`statisticLimitsOf`) in one
   * call, and for the App in one minute, all its calls together, kept in
   * memory (a restart of this object starts the minute again).
   * `statistics.rate_limited` past either, and `app.caller_invalid` for a
   * token of no running call.
   */
  claimStatistic(
    token: string,
    use: StatisticUse
  ): ReturnType<App["callerOf"]> {
    const resolved = this.callerOf(token);
    const call = this.#calls.get(token);
    if (call === undefined) {
      throw appErrors.create("app.caller_invalid");
    }
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#statisticsMinute.minute !== minute) {
      this.#statisticsMinute = { minute, point: 0, read: 0 };
    }
    const { perCall, perMinute } = statisticLimitsOf(
      use,
      use === "point"
        ? this.env.STATISTICS_POINT_LIMITS
        : this.env.STATISTICS_READ_LIMITS
    );
    const counts = call.statistics ?? { point: 0, read: 0 };
    if (counts[use] >= perCall || this.#statisticsMinute[use] >= perMinute) {
      throw statisticErrors.create("statistics.rate_limited", {
        use,
        perCall,
        perMinute,
      });
    }
    call.statistics = { ...counts, [use]: counts[use] + 1 };
    this.#statisticsMinute[use] += 1;
    return resolved;
  }

  /**
   * Who the running call `token` names acts for, as `callerOf` says, for
   * the audit of a read refused past its bounds: the first one in a
   * minute, for the App; undefined for the rest of that minute, so a loop
   * can't flood the audit log.
   */
  limitedReadAudit(token: string): ReturnType<App["callerOf"]> | undefined {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#limitedAuditMinute === minute) {
      return undefined;
    }
    const resolved = this.callerOf(token);
    this.#limitedAuditMinute = minute;
    return resolved;
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
}

/**
 * Calls a method of an App's server code for `caller`: a person in a
 * session (screens), or the person a workflow run acts for. Core takes the
 * caller from the session or the run, never from the request. Anything
 * that fails outside the App's own errors comes back as
 * `internal.unexpected`. Screens and workflows alike call Apps only
 * through here.
 */
export const callApp = async (
  env: Env,
  app: AppId,
  caller: AppCallerInput,
  method: string,
  args: unknown[] = []
): Promise<AppAnswer> => {
  try {
    return await appHost(env, app).call(caller, method, args);
  } catch (error) {
    throw forCaller(error, app, undefined, method);
  }
};
