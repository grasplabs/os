import {
  appModuleName,
  kitModuleName,
  kitModules,
  screenRuntime,
} from "@grasp-os/compiler";
import { appErrors, appVersionSchema } from "@grasp-os/shared/apps";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  screenErrors,
  screenNameSchema,
  screenProblemSchema,
} from "@grasp-os/shared/screens";
import type {
  AppErrorEntry,
  ScreenBundle,
  ScreensApi,
} from "@grasp-os/shared/screens";
import { RpcStub, RpcTarget } from "capnweb";
import { z } from "zod";

import { callApp, isPlainData } from "./app.ts";
import type { AppAnswer } from "./app.ts";
import { getApp, getVersion, versionFiles } from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { buildFailed, buildScreens } from "./screens.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

// What the frontend's screen host reaches for the frames it runs (see
// @grasp-os/sdk/screen-runtime): an App's screen to load, its server to
// call, its current version and its error log. Screens run code nobody
// reviewed line by line, which the page passes on as it is, so everything
// here takes the frame's input as untrusted and checks the person's
// session and role on every call.
//
// Apps have no members or roles of their own yet: until they do, only the
// platform roles that build Apps (admins and builders) use their screens,
// as only they can see Apps at all (apps.ts).

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
 * to subscribe again.
 */
const callbackFor = (stub: RpcStub<Callback>): Callback & Disposable => {
  const toScreen = stub.dup();
  return Object.assign(
    async (value: AppAnswer): Promise<void> => {
      if (!isPlainData(value)) {
        throw appErrors.create("app.answer_invalid");
      }
      await toScreen(value);
    },
    {
      [Symbol.dispose]: () => {
        toScreen[Symbol.dispose]();
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
  args: unknown[]
): { passed: unknown[]; callbacks: Disposable[] } => {
  if (!args.every((arg) => isStub(arg) || isPlainData(arg))) {
    throw screenErrors.create("screen.invalid");
  }
  const callbacks: Disposable[] = [];
  const passed = args.map((arg) => {
    if (!isStub(arg)) {
      return arg;
    }
    const callback = callbackFor(arg);
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
  { app, method, args }: { app: unknown; method: unknown; args: unknown }
): Promise<AppAnswer> => {
  const { id } = await getApp(env, by, app);
  if (typeof method !== "string" || !Array.isArray(args)) {
    throw screenErrors.create("screen.invalid");
  }
  const { passed, callbacks } = argumentsFor(args);
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
  // One of the App's versions, or `app.version_not_found`.
  const { app: id } = await getVersion(env, by, app, where.version);
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
  const { id } = await getApp(env, by, app);
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

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
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
      async (by) => await callServer(this.#env, by, { app, method, args })
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
}
