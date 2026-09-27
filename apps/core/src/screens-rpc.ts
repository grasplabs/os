import {
  appModuleName,
  kitModuleName,
  kitModules,
  screenRuntime,
} from "@grasp-os/compiler";
import { appErrors, appVersionSchema } from "@grasp-os/shared/apps";
import type { DecisionView } from "@grasp-os/shared/decisions";
import { isExpectedError } from "@grasp-os/shared/errors";
import type { AppId } from "@grasp-os/shared/ids";
import { errorFields, log } from "@grasp-os/shared/log";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  screenErrors,
  screenNameSchema,
  screenProblemSchema,
} from "@grasp-os/shared/screens";
import type {
  AppErrorEntry,
  RunChange,
  ScreenBundle,
  ScreenRun,
  ScreensApi,
} from "@grasp-os/shared/screens";
import type { WorkflowRun } from "@grasp-os/shared/workflows";
import { RpcStub, RpcTarget } from "capnweb";
import { z } from "zod";

import { callApp, isPlainData } from "./app.ts";
import type { AppAnswer } from "./app.ts";
import { appFor, findVersion, getApp, versionFiles } from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { RunSubscription } from "./run-subscription.ts";
import { buildFailed, buildScreens } from "./screens.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";
import {
  decideScreenRun,
  requireScreenWorkflows,
  screenRun,
  screenRuns,
  screenWorkflow,
  startScreenRun,
} from "./workflows/screen-runs.ts";

// What the frontend's screen host reaches for the frames it runs (see
// @grasp-os/sdk/screen-runtime): an App's screen to load, its server to
// call, its current version and its error log. Screens run code nobody
// reviewed line by line, which the page passes on as it is, so everything
// here takes the frame's input as untrusted and checks the person's
// session and role on every call.
//
// Anyone with a role in the App (app-access.ts) uses its screens: opens
// them, calls its server, reports problems, and starts, follows and
// answers its workflow runs (workflows/screen-runs.ts). Only its builders
// read its error log.
//
// A callback the App keeps (a screen's subscription), or its host keeps
// for the App's run changes (`watchRuns`), outlives the call that passed
// it, so each push through it checks again that the person
// still has a role in the App (`stillOpen`), at most every
// `recheckMs` per App and connection. Once they don't (unshared, a team
// left, a role changed, a source they can't read), the callback is
// released and forwards nothing more: losing access stops a screen within
// a few seconds, whatever the App does.

/** How long one answer to whether the person may still use an App holds. */
const recheckMs = 5000;

/**
 * Most run subscriptions (`watchRuns`) one connection keeps at once. A
 * connection is one open screen, which follows a workflow or two: this
 * only bounds what a screen that subscribes over and over keeps in its
 * App's host.
 */
const maxRunSubscriptions = 20;

/** Whether the person may still use the App, as a push through a callback asks. */
type StillOpen = () => Promise<boolean>;

/** A running App's screen, built from its current version. */
const openScreen = async (
  env: Env,
  by: Identity,
  app: unknown,
  screen: unknown
): Promise<ScreenBundle> => {
  const {
    id,
    name: appName,
    currentVersion: version,
  } = await getApp(env, by, app);
  const name = screenErrors.parse("screen.invalid", screenNameSchema, screen);
  if (version === null) {
    throw appErrors.create("app.not_running");
  }
  const files = await versionFiles(env, id, version);
  const path = `screens/${name}.tsx`;
  if (!Object.hasOwn(files, path)) {
    throw screenErrors.create("screen.not_found");
  }
  const build = await buildScreens(env, {
    app: id,
    version: String(version),
    files,
  });
  if (!build.ok) {
    throw screenErrors.create(
      "screen.build_failed",
      buildFailed(version, build)
    );
  }
  const { modules } = await kitModules(env.ASSETS);
  return {
    app: id,
    name: appName,
    version,
    screen: name,
    entry: appModuleName(path),
    runtime: kitModuleName(screenRuntime),
    modules: build.modules,
    kit: Object.fromEntries(
      build.kitModules.map((module) => [module, modules[module] ?? ""])
    ),
    css: build.css,
  };
};

/** A function the App gets for a callback the screen passed. */
type Callback = (value: AppAnswer) => Promise<void>;

/**
 * A stub of the frame's: a function (or object) of the screen's, which the
 * App may only call.
 */
const isStub = (value: unknown): value is RpcStub<Callback> =>
  value instanceof RpcStub;

/**
 * The screen's callback `stub` as a function the App can keep and call
 * later: it passes on plain data only, never a way into the App (a stub or
 * a function of its own), and gives the App nothing back from the screen.
 * It's released by the runtime when the App lets it go (right after a
 * call that didn't keep it, or when the App drops it later), or by
 * `callServer` after a failure; releasing a stub twice does nothing.
 * Releasing it releases the screen's callback too, which tells the screen
 * to subscribe again. Before each push, `stillOpen` checks the person may
 * still use the App; once they may not, it releases itself and refuses
 * the push, and every one after. `released`, if given, is called once it's
 * released, however that happened.
 */
const callbackFor = (
  stub: RpcStub<Callback>,
  stillOpen: StillOpen,
  released?: () => void
): Callback & Disposable => {
  const toScreen = stub.dup();
  return Object.assign(
    async (value: AppAnswer): Promise<void> => {
      if (!isPlainData(value)) {
        throw appErrors.create("app.answer_invalid");
      }
      if (!(await stillOpen())) {
        toScreen[Symbol.dispose]();
        throw appErrors.create("app.not_found");
      }
      await toScreen(value);
    },
    {
      [Symbol.dispose]: () => {
        toScreen[Symbol.dispose]();
        released?.();
      },
    }
  );
};

/**
 * The arguments for the App: plain data, and callbacks of the screen's
 * (how `live` in @grasp-os/sdk/screen subscribes), each as a function the
 * App can only call.
 */
const argumentsFor = (
  args: unknown[],
  stillOpen: StillOpen
): { passed: unknown[]; callbacks: Disposable[] } => {
  if (!args.every((arg) => isStub(arg) || isPlainData(arg))) {
    throw screenErrors.create("screen.invalid");
  }
  const callbacks: Disposable[] = [];
  const passed = args.map((arg) => {
    if (!isStub(arg)) {
      return arg;
    }
    const callback = callbackFor(arg, stillOpen);
    callbacks.push(callback);
    return callback;
  });
  return { passed, callbacks };
};

/**
 * Calls a method of the App's server for the person: plain data and a
 * screen's callbacks go in, plain data comes out, whatever it holds. The
 * name must be a string before it goes anywhere near the App, so an object
 * can't turn into a different one between the check and the call.
 */
const callServer = async (
  env: Env,
  by: Identity,
  { app, method, args }: { app: unknown; method: unknown; args: unknown },
  stillOpenFor: (app: AppId) => StillOpen
): Promise<AppAnswer> => {
  const { id } = await getApp(env, by, app);
  if (typeof method !== "string" || !Array.isArray(args)) {
    throw screenErrors.create("screen.invalid");
  }
  const { passed, callbacks } = argumentsFor(args, stillOpenFor(id));
  try {
    return await callApp(
      env,
      id,
      { userId: by.userId, mode: "interactive" },
      method,
      passed
    );
  } catch (error) {
    // A failed call keeps no callback.
    for (const callback of callbacks) {
      callback[Symbol.dispose]();
    }
    throw error;
  }
};

/**
 * Follows the App's runs of `workflow` for the person (app.ts,
 * `watchRuns`): the screen's callback goes to the App's host as a
 * function it can only call, checked before each push as any callback of
 * a screen is. `subscriptions` holds this connection's, which drop out
 * once released: at most {@link maxRunSubscriptions} at once.
 */
const watchRuns = async (
  env: Env,
  by: Identity,
  {
    app,
    workflow,
    onChange,
  }: { app: unknown; workflow: unknown; onChange: unknown },
  stillOpenFor: (app: AppId) => StillOpen,
  subscriptions: Set<Disposable>
): Promise<RunSubscription> => {
  requireScreenWorkflows(env);
  const { id } = await getApp(env, by, app);
  const name = screenWorkflow(workflow);
  if (!isStub(onChange)) {
    throw screenErrors.create("screen.invalid");
  }
  if (subscriptions.size >= maxRunSubscriptions) {
    throw screenErrors.create("screen.too_many_subscriptions");
  }
  const callback: Callback & Disposable = callbackFor(
    onChange,
    stillOpenFor(id),
    () => {
      subscriptions.delete(callback);
    }
  );
  subscriptions.add(callback);
  let watch: string;
  try {
    watch = await appHost(env, id).watchRuns(name, callback);
  } catch (error) {
    callback[Symbol.dispose]();
    throw error;
  }
  return new RunSubscription(async () => {
    // The slot is free at once, and the callback forwards nothing more;
    // the host drops it now, or at its next push if it can't be reached.
    callback[Symbol.dispose]();
    try {
      await appHost(env, id).unwatchRuns(name, watch);
    } catch (error) {
      log.warn("screen.unwatch_failed", { appId: id, ...errorFields(error) });
    }
  });
};

/**
 * Whether the person behind the connection still has a role in `app`,
 * read now: the connection's own session check (`check`), which reads
 * their session, role and teams as every call does, Grasp staff's
 * window included, then the App's rules (`appFor`). Anything that goes
 * wrong on the way is a no: a callback must not outlive access because a
 * check failed. A session that ended also closes the connection, as on
 * any call.
 */
const hasRole = async (
  env: Env,
  check: SessionCheck,
  app: AppId
): Promise<boolean> => {
  try {
    await appFor(env, await check(), app, "user");
    return true;
  } catch (error) {
    if (!isExpectedError(error)) {
      log.error("screen.access_check_failed", {
        appId: app,
        ...errorFields(error),
      });
    }
    return false;
  }
};

/** Where in a screen a problem happened, as the page reports it. */
const reportedAtSchema = z.strictObject({
  version: appVersionSchema,
  screen: screenNameSchema,
});

const reportProblem = async (
  env: Env,
  by: Identity,
  app: unknown,
  at: unknown,
  problem: unknown
): Promise<void> => {
  const where = screenErrors.parse("screen.invalid", reportedAtSchema, at);
  const { id } = await getApp(env, by, app);
  // One of the App's versions, or `app.version_not_found`.
  await findVersion(env, id, where.version);
  const entry: AppErrorEntry = {
    at: new Date().toISOString(),
    source: "screen",
    ...where,
    ...screenErrors.parse("screen.invalid", screenProblemSchema, problem),
  };
  await appHost(env, id).logError(entry);
};

const errorLog = async (
  env: Env,
  by: Identity,
  app: unknown
): Promise<AppErrorEntry[]> => {
  const { id } = await appFor(env, by, app, "builder");
  return await appHost(env, id).errors();
};

/**
 * A signed-in person's `screens`. Like the other APIs of a session, every
 * call checks the session first and hands the identity that check returned
 * on; each function checks the person's role.
 */
export class ScreensRpc extends RpcTarget implements ScreensApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  /** This connection's run subscriptions that haven't been released. */
  readonly #runSubscriptions = new Set<Disposable>();

  /** The latest answer to whether the person may use each App, and until when it holds. */
  readonly #access = new Map<
    AppId,
    { open: Promise<boolean>; until: number }
  >();

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  /**
   * Whether the person may still use `app`, for this connection's callbacks:
   * read again at most every `recheckMs`, and shared by every push
   * meanwhile.
   */
  #stillOpen(app: AppId): StillOpen {
    return async () => {
      const now = Date.now();
      const cached = this.#access.get(app);
      if (cached !== undefined && cached.until > now) {
        return await cached.open;
      }
      const open = hasRole(this.#env, this.#check, app);
      this.#access.set(app, { open, until: now + recheckMs });
      return await open;
    };
  }

  async open(app: string, screen: string): Promise<ScreenBundle> {
    return await withPerson(
      this.#check,
      async (by) => await openScreen(this.#env, by, app, screen)
    );
  }

  async call(app: string, method: string, args: unknown[]): Promise<unknown> {
    return await withPerson(
      this.#check,
      async (by) =>
        await callServer(this.#env, by, { app, method, args }, (id) =>
          this.#stillOpen(id)
        )
    );
  }

  async version(app: string): Promise<number | null> {
    return await withPerson(this.#check, async (by) => {
      const { currentVersion } = await getApp(this.#env, by, app);
      return currentVersion;
    });
  }

  async report(
    app: string,
    at: { version: number; screen: string },
    problem: unknown
  ): Promise<void> {
    await withPerson(this.#check, async (by) => {
      await reportProblem(this.#env, by, app, at, problem);
    });
  }

  async errors(app: string): Promise<AppErrorEntry[]> {
    return await withPerson(
      this.#check,
      async (by) => await errorLog(this.#env, by, app)
    );
  }

  async startRun(
    app: string,
    workflow: string,
    input?: unknown
  ): Promise<WorkflowRun> {
    return await withPerson(
      this.#check,
      async (by) => await startScreenRun(this.#env, by, app, workflow, input)
    );
  }

  async runs(app: string, workflow: string): Promise<ScreenRun[]> {
    return await withPerson(
      this.#check,
      async (by) => await screenRuns(this.#env, by, app, workflow)
    );
  }

  async run(app: string, run: string): Promise<ScreenRun> {
    return await withPerson(
      this.#check,
      async (by) => await screenRun(this.#env, by, app, run)
    );
  }

  async decide(
    app: string,
    run: string,
    decision: string,
    answer: unknown
  ): Promise<DecisionView> {
    return await withPerson(
      this.#check,
      async (by) =>
        await decideScreenRun(this.#env, by, app, run, decision, answer)
    );
  }

  async watchRuns(
    app: string,
    workflow: string,
    onChange: (change: RunChange) => void
  ): Promise<RunSubscription> {
    return await withPerson(
      this.#check,
      async (by) =>
        await watchRuns(
          this.#env,
          by,
          { app, workflow, onChange },
          (id) => this.#stillOpen(id),
          this.#runSubscriptions
        )
    );
  }
}
