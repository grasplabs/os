/**
 * What runs an App's screen inside its sandboxed frame: it connects to the
 * page around the frame over the `MessagePort` the page hands it, renders
 * the screen, follows the page's theme and reports the screen's errors.
 * The frame's own document (served by core) loads this module first; App
 * code uses `@grasp-os/sdk/screen`, never this.
 *
 * The frame is a sandbox with an opaque origin and no network, so the port
 * is the screen's only way out: to its App's server, through the page,
 * which binds it to that one App.
 */
import type { ScreenProblem } from "@grasp-os/shared/screens";
import { newMessagePortRpcSession } from "capnweb";
import type { RpcStub } from "capnweb";
import { createElement } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";

export type Theme = "light" | "dark";

/**
 * What the page gives the frame over its port, and nothing else. Answers
 * and failures come back as they are; a screen reads them as its own data.
 */
export interface ScreenBridge {
  /**
   * Calls `method` of the App's server with `args`, for the person using
   * the screen. Functions among `args` reach the server as callbacks it
   * can keep and call later.
   */
  call: (method: string, args: unknown[]) => Promise<unknown>;
  /** Adds a problem to the App's error log. */
  report: (problem: ScreenProblem) => void;
  /** Calls `onTheme` with the page's theme now and whenever it changes. */
  theme: (onTheme: (theme: Theme) => void) => void;
}

let connected: RpcStub<ScreenBridge> | undefined;

/** The page's bridge, once the frame has connected. */
export const bridge = (): RpcStub<ScreenBridge> => {
  if (!connected) {
    throw new Error("The screen isn't connected to its page yet.");
  }
  return connected;
};

/** Connects the frame to the page's bridge over `port`. */
export const connectBridge = (port: MessagePort): RpcStub<ScreenBridge> => {
  connected = newMessagePortRpcSession<ScreenBridge>(port);
  return connected;
};

/** An error's message and stack, as far as it has them, never throwing. */
const describe = (value: unknown): Pick<ScreenProblem, "message" | "stack"> => {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  try {
    return { message: typeof value === "string" ? value : String(value) };
  } catch {
    return { message: "(an error that can't be shown)" };
  }
};

const send = async (problem: ScreenProblem): Promise<void> => {
  try {
    await bridge().report(problem);
  } catch {
    // Reporting must never fail the screen, or report itself.
  }
};

const report = (problem: ScreenProblem): void => {
  void send(problem);
};

/** Sends the screen's uncaught errors and `console.error` calls to the page. */
const reportProblems = (): void => {
  addEventListener("error", (event) => {
    report({ kind: "error", ...describe(event.error ?? event.message) });
  });
  addEventListener("unhandledrejection", (event) => {
    report({ kind: "rejection", ...describe(event.reason) });
  });
  const logError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    logError(...args);
    const [first] = args;
    const described = describe(first);
    report({
      kind: "console",
      ...described,
      message: args.map((arg) => describe(arg).message).join(" "),
    });
  };
};

const isScreenModule = (value: unknown): value is { default: ComponentType } =>
  typeof value === "object" &&
  value !== null &&
  "default" in value &&
  typeof value.default === "function";

/**
 * Runs the screen whose module is `screen` (a name in the frame's import
 * map), connected to the page through `port`.
 */
export const runScreen = async (
  port: MessagePort,
  screen: string
): Promise<void> => {
  const page = connectBridge(port);
  reportProblems();
  const root = document.createElement("div");
  document.body.append(root);
  try {
    await page.theme((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
    });
    const loaded: unknown = await import(screen);
    if (!isScreenModule(loaded)) {
      throw new Error(`${screen} has no default export to render.`);
    }
    createRoot(root, {
      onUncaughtError: (error) => {
        report({ kind: "error", ...describe(error) });
      },
    }).render(createElement(loaded.default));
  } catch (error) {
    report({ kind: "error", ...describe(error) });
  }
};
