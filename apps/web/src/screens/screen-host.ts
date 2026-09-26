import type { ScreenBridge, Theme } from "@grasp-os/sdk/screen-runtime";
import { appErrors } from "@grasp-os/shared/apps";
import { authErrors, featureErrors } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
import {
  screenErrors,
  screenFrameMessage,
  screenFramePath,
  screenFrameReady,
  screenProblemSchema,
} from "@grasp-os/shared/screens";
import type { ScreenBundle, ScreenProblem } from "@grasp-os/shared/screens";
import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";

import { CoreLink } from "./core-link.ts";

// The page's side of an App's screen. The screen runs in a sandboxed frame
// (core's screen-frame.ts) with no network; the page hands it its code and
// a Cap'n Web bridge over a `MessagePort`, which reaches only its own App's
// server, through the page's own connection to core. Core checks the
// person's session and role on every call; the page binds the bridge to
// one App, which the frame can't change.
//
// Nothing the frame sends or its App answers is ever read as the platform
// speaking: answers and failures go back to the frame as they are, and the
// page shows a session as ended only when its own connection says so.

/** What the page shows about a screen besides the screen itself. */
export type ScreenState =
  | { status: "loading" }
  | { status: "running" }
  | { status: "updated" }
  | { status: "signed-out" }
  | { status: "failed"; reason: FailureReason };

export type FailureReason =
  | "disabled"
  | "forbidden"
  | "not-found"
  | "not-running"
  | "broken"
  | "unknown";

/** How often the page asks whether the App has a new current version. */
const versionCheckMs = 30_000;
/** How many problems a screen may report a minute; the rest are dropped. */
const reportsPerMinute = 20;
const minuteMs = 60_000;

const failures: Readonly<Record<string, FailureReason>> = {
  "feature.disabled": "disabled",
  "role.forbidden": "forbidden",
  "app.not_found": "not-found",
  "screen.not_found": "not-found",
  "screen.invalid": "not-found",
  "app.not_running": "not-running",
  "screen.build_failed": "broken",
};

/** Why opening a screen failed, as the page says it. */
const failureOf = (error: unknown): FailureReason => {
  const code =
    featureErrors.codeOf(error) ??
    roleErrors.codeOf(error) ??
    appErrors.codeOf(error) ??
    screenErrors.codeOf(error);
  return (code === undefined ? undefined : failures[code]) ?? "unknown";
};

/** The page's theme, as the `dark` class on its root says (theme.js). */
const pageTheme = (): Theme =>
  document.documentElement.classList.contains("dark") ? "dark" : "light";

type ThemeCallback = (theme: Theme) => void;

/**
 * A stub the frame passed for its theme callback. The page only calls it;
 * a stub of anything else fails in the frame, not here.
 */
const isThemeCallback = (value: unknown): value is RpcStub<ThemeCallback> =>
  value instanceof RpcStub;

/** Sends the page's theme to the frame, until the frame is gone. */
const sendTheme = async (
  toFrame: RpcStub<ThemeCallback>,
  observer: MutationObserver
): Promise<void> => {
  try {
    await toFrame(pageTheme());
  } catch {
    observer.disconnect();
  }
};

/**
 * What the frame reaches through its port: its own App's server, the
 * App's error log and the page's theme. Everything it passes is untrusted.
 */
class Bridge extends RpcTarget implements ScreenBridge {
  readonly #link: CoreLink;
  readonly #bundle: ScreenBundle;
  readonly #cleanups: (() => void)[];
  #reports = 0;
  #themed = false;

  constructor(link: CoreLink, bundle: ScreenBundle, cleanups: (() => void)[]) {
    super();
    this.#link = link;
    this.#bundle = bundle;
    this.#cleanups = cleanups;
    const timer = setInterval(() => {
      this.#reports = 0;
    }, minuteMs);
    cleanups.push(() => {
      clearInterval(timer);
    });
  }

  async call(method: unknown, args: unknown): Promise<unknown> {
    if (typeof method !== "string" || !Array.isArray(args)) {
      throw screenErrors.create("screen.invalid");
    }
    const session = await this.#link.session();
    return await session.screens.call(this.#bundle.app, method, args);
  }

  report(problem: unknown): void {
    const parsed = screenProblemSchema.safeParse(problem);
    if (!parsed.success || this.#reports >= reportsPerMinute) {
      return;
    }
    this.#reports += 1;
    void this.#report(parsed.data);
  }

  /** Once per frame: each call would keep another observer and stub. */
  theme(onTheme: unknown): void {
    if (this.#themed || !isThemeCallback(onTheme)) {
      return;
    }
    this.#themed = true;
    const toFrame = onTheme.dup();
    const observer = new MutationObserver(() => {
      void sendTheme(toFrame, observer);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    void sendTheme(toFrame, observer);
    this.#cleanups.push(() => {
      observer.disconnect();
      toFrame[Symbol.dispose]();
    });
  }

  async #report(problem: ScreenProblem): Promise<void> {
    const { app, version, screen } = this.#bundle;
    try {
      const session = await this.#link.session();
      await session.screens.report(app, { version, screen }, problem);
    } catch {
      // A problem that can't be reported is dropped: there's no one to tell.
    }
  }
}

/** A module as a URL the frame's import map can name. */
const dataUrl = (code: string): string =>
  `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

/** The frame's import map: the kit's modules it needs and the App's own. */
const importsOf = (bundle: ScreenBundle): Record<string, string> =>
  Object.fromEntries(
    [...Object.entries(bundle.kit), ...Object.entries(bundle.modules)].map(
      ([name, code]) => [name, dataUrl(code)]
    )
  );

/** Whether a message says the frame document loaded as `load` listens. */
const isReady = (data: unknown, load: string): boolean =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === screenFrameReady &&
  "load" in data &&
  data.load === load;

/**
 * Loads the frame document into `frame`, and resolves once it says it
 * listens. Only the document of this load counts, once: not one from an
 * earlier load, nor one the frame navigates to later.
 */
const loadFrame = async (
  frame: HTMLIFrameElement,
  signal: AbortSignal
): Promise<void> => {
  const load = crypto.randomUUID();
  // oxlint-disable-next-line promise/avoid-new -- a message event has no promise form
  const ready = new Promise<void>((resolve) => {
    const listen = (event: MessageEvent): void => {
      // Only the frame's own document, whose origin is opaque: "null".
      if (
        event.source === frame.contentWindow &&
        event.origin === "null" &&
        isReady(event.data, load)
      ) {
        window.removeEventListener("message", listen);
        resolve();
      }
    };
    window.addEventListener("message", listen, { signal });
  });
  // Only now: the page listens before the frame can say it's ready.
  frame.src = `${screenFramePath}?${new URLSearchParams({ load })}`;
  await ready;
};

/**
 * Runs `screen` of `app` in `frame`: loads it, hands the frame its code and
 * bridge, and watches for a new current version. Tells the page what to
 * show with `onState`, and the App's name with `onOpened`. Returns a
 * function that stops it all.
 */
export const runScreen = (
  frame: HTMLIFrameElement,
  app: string,
  screen: string,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
): (() => void) => {
  const stopped = new AbortController();
  const cleanups: (() => void)[] = [];
  const link = new CoreLink(() => {
    onState({ status: "signed-out" });
  });

  const checkVersion = async (version: number): Promise<void> => {
    try {
      const session = await link.session();
      if ((await session.screens.version(app)) !== version) {
        onState({ status: "updated" });
      }
    } catch {
      // Asked again at the next check.
    }
  };

  const start = async (): Promise<void> => {
    const ready = loadFrame(frame, stopped.signal);
    const session = await link.session();
    const bundle = await session.screens.open(app, screen);
    await ready;
    if (stopped.signal.aborted) {
      return;
    }
    const { port1, port2 } = new MessageChannel();
    const bridge = newMessagePortRpcSession(
      port1,
      new Bridge(link, bundle, cleanups)
    );
    cleanups.push(() => {
      bridge[Symbol.dispose]();
    });
    frame.contentWindow?.postMessage(
      {
        type: screenFrameMessage,
        imports: importsOf(bundle),
        css: bundle.css,
        runtime: bundle.runtime,
        entry: bundle.entry,
      },
      "*",
      [port2]
    );
    onOpened(bundle.name);
    onState({ status: "running" });
    const timer = setInterval(() => {
      void checkVersion(bundle.version);
    }, versionCheckMs);
    cleanups.push(() => {
      clearInterval(timer);
    });
  };

  const run = async (): Promise<void> => {
    try {
      await start();
    } catch (error) {
      if (stopped.signal.aborted) {
        return;
      }
      onState(
        authErrors.codeOf(error) === "auth.unauthenticated"
          ? { status: "signed-out" }
          : { status: "failed", reason: failureOf(error) }
      );
    }
  };
  void run();

  return () => {
    stopped.abort();
    for (const cleanup of cleanups) {
      cleanup();
    }
    link.close();
  };
};
