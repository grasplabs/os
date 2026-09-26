import {
  appModuleName,
  kitModuleName,
  kitModules,
  screenRuntime,
} from "@grasp-os/compiler";
import { appErrors, appVersionSchema } from "@grasp-os/shared/apps";
import { issuesOf } from "@grasp-os/shared/errors";
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

import { callApp } from "./app.ts";
import type { AppAnswer } from "./app.ts";
import { getApp, getVersion, versionFiles } from "./apps.ts";
import { appHost } from "./durable-objects.ts";
import { buildScreens } from "./screens.ts";
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

/** `input` as `schema` has it, or `screen.invalid` saying why not. */
const parse = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown
): z.output<Schema> => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw screenErrors.create("screen.invalid", {
      issues: issuesOf(parsed.error),
    });
  }
  return parsed.data;
};

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
  const name = parse(screenNameSchema, screen);
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
    throw screenErrors.create("screen.build_failed", {
      version,
      diagnostics: build.diagnostics.map(({ file, line, message }) => ({
        file: file ?? null,
        line: line ?? null,
        message,
      })),
    });
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

/** Whether a value is plain data, as structured clone carries it. */
const isPlain = (value: unknown): boolean => {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
};

/** A function the App gets for a callback the screen passed. */
type Callback = (value: AppAnswer) => Promise<void>;

/**
 * How many callbacks one connection may have with its Apps at once. The
 * runtime releases one when the App lets it go (right after a call that
 * didn't keep it, or when the App drops it later) or when the connection
 * ends, so this bounds what a screen can pile up in core; a screen needs
 * one per live subscription.
 */
export const callbacksPerConnection = 64;

/** The callbacks a connection's Apps hold now. */
export interface CallbackCount {
  live: number;
}

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
 * It counts in `count` until it is released, once, whoever releases it:
 * the runtime when the App lets it go, or `callServer` after a failure.
 * Releasing it releases the screen's callback too, which tells the screen
 * to subscribe again.
 */
const callbackFor = (
  stub: RpcStub<Callback>,
  count: CallbackCount
): Callback & Disposable => {
  const toScreen = stub.dup();
  let released = false;
  count.live += 1;
  return Object.assign(
    async (value: AppAnswer): Promise<void> => {
      if (!isPlain(value)) {
        throw appErrors.create("app.answer_invalid");
      }
      await toScreen(value);
    },
    {
      [Symbol.dispose]: () => {
        if (!released) {
          released = true;
          count.live -= 1;
          toScreen[Symbol.dispose]();
        }
      },
    }
  );
};

/**
 * The arguments for the App: plain data, and at most one callback of the
 * screen's, as the last argument (how `live` in @grasp-os/sdk/screen
 * subscribes).
 */
const argumentsFor = (
  args: unknown[],
  count: CallbackCount
): { passed: unknown[]; callback?: Disposable } => {
  const last = args.at(-1);
  const data = isStub(last) ? args.slice(0, -1) : args;
  if (!data.every((arg) => !isStub(arg) && isPlain(arg))) {
    throw screenErrors.create("screen.invalid");
  }
  if (!isStub(last)) {
    return { passed: data };
  }
  if (count.live >= callbacksPerConnection) {
    throw screenErrors.create("screen.invalid", {
      issues: [`At most ${callbacksPerConnection} live callbacks`],
    });
  }
  const callback = callbackFor(last, count);
  return { passed: [...data, callback], callback };
};

/**
 * Calls a method of the App's server for the person: plain data and a
 * screen's callback go in, plain data comes out, whatever it holds. The
 * name must be a string before it goes anywhere near the App, so an object
 * can't turn into a different one between the check and the call.
 */
const callServer = async (
  env: Env,
  by: Identity,
  count: CallbackCount,
  { app, method, args }: { app: unknown; method: unknown; args: unknown }
): Promise<AppAnswer> => {
  const { id } = await getApp(env, by, app);
  if (typeof method !== "string" || !Array.isArray(args)) {
    throw screenErrors.create("screen.invalid");
  }
  const { passed, callback } = argumentsFor(args, count);
  try {
    return await callApp(
      env,
      id,
      { userId: by.userId, mode: "interactive" },
      method,
      passed
    );
  } catch (error) {
    // A failed call keeps no callback. Releasing is idempotent, so the
    // runtime releasing it as well counts once.
    callback?.[Symbol.dispose]();
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
  const where = parse(reportedAtSchema, at);
  // One of the App's versions, or `app.version_not_found`.
  const { app: id } = await getVersion(env, by, app, where.version);
  const entry: AppErrorEntry = {
    at: new Date().toISOString(),
    source: "screen",
    ...where,
    ...parse(screenProblemSchema, problem),
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
  /** Built once per connection, so this counts the connection's callbacks. */
  readonly #callbacks: CallbackCount = { live: 0 };

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
      async (by) =>
        await callServer(this.#env, by, this.#callbacks, { app, method, args })
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
