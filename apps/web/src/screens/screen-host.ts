import type { ScreenBridge, Theme } from "@grasp-os/sdk/screen-runtime";
import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewBundle } from "@grasp-os/shared/chat";
import { authErrors } from "@grasp-os/shared/errors";
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
// A preview of a chat's draft (`runPreview`) runs the same way, in the same
// frame, with its bridge bound to the draft instead: its server calls go to
// the draft's preview in core, which has no side effects; what its screen
// reports goes to the chat's agent; and its calls on the App's workflow
// runs start nothing and find none.
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
/**
 * How long a preview's screen runs before the page tells the agent it
 * rendered: what goes wrong while it starts has been reported by then.
 */
const renderedAfterMs = 1500;

const failures: Readonly<Record<string, FailureReason>> = {
  "role.forbidden": "forbidden",
  "app.unreadable": "forbidden",
  "app.not_found": "not-found",
  "app.no_draft": "not-found",
  "screen.not_found": "not-found",
  "screen.invalid": "not-found",
  "app.not_running": "not-running",
  "screen.build_failed": "broken",
};

/** Why opening a screen failed, as the page says it. */
const failureOf = (error: unknown): FailureReason => {
  const code =
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

/** A string the frame passed, or `screen.invalid`. */
const text = (value: unknown): string => {
  if (typeof value !== "string") {
    throw screenErrors.create("screen.invalid");
  }
  return value;
};

/**
 * `value` as what core's call takes: the frame's input, passed on as it is
 * for core to check, as `call` passes its arguments.
 */
const forCore = (value: unknown): never =>
  // SAFETY: core checks every value a screen sends (screens-rpc.ts); the
  // page only binds the call to the screen's own App.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/**
 * Where a frame's calls go, checked by the bridge first: a running App's
 * screen (`appTarget`), or a draft's preview (`previewTarget`).
 */
interface FrameTarget {
  call: (method: string, args: unknown[]) => Promise<unknown>;
  report: (problem: ScreenProblem) => Promise<void>;
  startRun: (workflow: string, input: unknown) => Promise<unknown>;
  runs: (workflow: string) => Promise<unknown>;
  run: (run: string) => Promise<unknown>;
  decide: (run: string, decision: string, answer: unknown) => Promise<unknown>;
  watchRuns: (workflow: string, onChange: unknown) => Promise<unknown>;
}

/**
 * What the frame reaches through its port: its target (its own App's
 * server and workflow runs, and where its problems go) and the page's
 * theme. Everything it passes is untrusted.
 */
class Bridge extends RpcTarget implements ScreenBridge {
  readonly #target: FrameTarget;
  readonly #cleanups: (() => void)[];
  #reports = 0;
  #themed = false;

  constructor(target: FrameTarget, cleanups: (() => void)[]) {
    super();
    this.#target = target;
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
    return await this.#target.call(method, args);
  }

  async startRun(workflow: unknown, input: unknown): Promise<unknown> {
    return await this.#target.startRun(text(workflow), input);
  }

  async runs(workflow: unknown): Promise<unknown> {
    return await this.#target.runs(text(workflow));
  }

  async run(run: unknown): Promise<unknown> {
    return await this.#target.run(text(run));
  }

  async decide(
    run: unknown,
    decision: unknown,
    answer: unknown
  ): Promise<unknown> {
    return await this.#target.decide(text(run), text(decision), answer);
  }

  /**
   * The frame's callback goes on to core, which may only call it; the
   * subscription core answers goes back to the frame, to release.
   */
  async watchRuns(workflow: unknown, onChange: unknown): Promise<unknown> {
    return await this.#target.watchRuns(text(workflow), onChange);
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
    try {
      await this.#target.report(problem);
    } catch {
      // A problem that can't be reported is dropped: there's no one to tell.
    }
  }
}

/** A signed-in session's API, as the page's link to core gives it. */
type Session = Awaited<ReturnType<CoreLink["session"]>>;

/** Runs `run` on the link's signed-in session. */
const on = async <T>(
  link: CoreLink,
  run: (session: Session) => Promise<T>
): Promise<T> => {
  const session = await link.session();
  return await run(session);
};

/** A running App's screen: its own App's server, runs and error log. */
const appTarget = (link: CoreLink, bundle: ScreenBundle): FrameTarget => {
  const { app, version, screen } = bundle;
  return {
    call: async (method, args) =>
      await on(
        link,
        async ({ screens }) => await screens.call(app, method, args)
      ),
    report: async (problem) => {
      await on(link, async ({ screens }) => {
        await screens.report(app, { version, screen }, problem);
      });
    },
    startRun: async (workflow, input) =>
      await on(
        link,
        async ({ screens }) => await screens.startRun(app, workflow, input)
      ),
    runs: async (workflow) =>
      await on(link, async ({ screens }) => await screens.runs(app, workflow)),
    run: async (run) =>
      await on(link, async ({ screens }) => await screens.run(app, run)),
    decide: async (run, decision, answer) =>
      await on(
        link,
        async ({ screens }) =>
          await screens.decide(app, run, decision, forCore(answer))
      ),
    watchRuns: async (workflow, onChange) =>
      await on(
        link,
        async ({ screens }) =>
          await screens.watchRuns(app, workflow, forCore(onChange))
      ),
  };
};

/**
 * What a preview refuses: starting, reading or answering a workflow run.
 * The same refusal as core's for a call a preview stub refused
 * (`app.preview_side_effect`), and handled alike: the refusal itself
 * fails no check, and what the screen reports of it is the draft's, as
 * of any failed call (core's preview-reports.ts), since nothing the frame
 * sends can say it came of a refusal.
 */
const refusedInPreview = async (): Promise<never> => {
  await Promise.resolve();
  throw appErrors.create("app.preview_side_effect");
};

/**
 * A preview of the chat's draft: its server calls go to the draft's
 * preview, what its screen reports to the chat's agent; it starts no
 * workflow run, finds none, and follows none.
 */
const previewTarget = (
  link: CoreLink,
  chatId: string,
  bundle: PreviewBundle
): FrameTarget => {
  const { app, revision, screen } = bundle;
  return {
    call: async (method, args) =>
      await on(
        link,
        async ({ chats }) =>
          await chats.previewCall(chatId, app, revision, method, args)
      ),
    report: async (problem) => {
      await on(link, async ({ chats }) => {
        await chats.previewReport(chatId, app, revision, screen, problem);
      });
    },
    startRun: refusedInPreview,
    runs: async () => await Promise.resolve([]),
    run: refusedInPreview,
    decide: refusedInPreview,
    watchRuns: async () =>
      await Promise.resolve({
        release: async () => {
          await Promise.resolve();
        },
      }),
  };
};

/** A module as a URL the frame's import map can name. */
const dataUrl = (code: string): string =>
  `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

/** What a frame runs of a screen, and the App's name to show around it. */
type FrameCode = Pick<
  ScreenBundle,
  "name" | "entry" | "runtime" | "modules" | "kit" | "css"
>;

/** The frame's import map: the kit's modules it needs and the App's own. */
const importsOf = (bundle: FrameCode): Record<string, string> =>
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

/** What a frame runs, and what its bridge reaches. */
interface FrameSource<Bundle extends FrameCode> {
  open: (session: Session) => Promise<Bundle>;
  target: (link: CoreLink, bundle: Bundle) => FrameTarget;
  /**
   * Called once the screen runs: `cleanups` stop what it starts, and
   * `onState` says what the page shows.
   */
  running: (
    link: CoreLink,
    bundle: Bundle,
    cleanups: (() => void)[],
    onState: (state: ScreenState) => void
  ) => void;
}

/**
 * Runs what `source` opens in `frame`: loads it, and hands the frame its
 * code and bridge. Tells the page what to show with `onState`, and the
 * App's name with `onOpened`. Returns a function that stops it all.
 */
const runFrame = <Bundle extends FrameCode>(
  frame: HTMLIFrameElement,
  source: FrameSource<Bundle>,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
): (() => void) => {
  const stopped = new AbortController();
  const cleanups: (() => void)[] = [];
  const link = new CoreLink(() => {
    onState({ status: "signed-out" });
  });

  const start = async (): Promise<void> => {
    const ready = loadFrame(frame, stopped.signal);
    const bundle = await link.retrying(source.open);
    await ready;
    if (stopped.signal.aborted) {
      return;
    }
    const target = source.target(link, bundle);
    const { port1, port2 } = new MessageChannel();
    const bridge = newMessagePortRpcSession(
      port1,
      new Bridge(target, cleanups)
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
    source.running(link, bundle, cleanups, onState);
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

/**
 * Runs `screen` of `app` in `frame`, and watches for a new current
 * version (`runFrame`).
 */
export const runScreen = (
  frame: HTMLIFrameElement,
  app: string,
  screen: string,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
): (() => void) =>
  runFrame(
    frame,
    {
      open: async (session) => await session.screens.open(app, screen),
      target: appTarget,
      running: (link, { version }, cleanups, setState) => {
        const checkVersion = async (): Promise<void> => {
          try {
            const session = await link.session();
            if ((await session.screens.version(app)) !== version) {
              setState({ status: "updated" });
            }
          } catch {
            // Asked again at the next check.
          }
        };
        const timer = setInterval(() => {
          void checkVersion();
        }, versionCheckMs);
        cleanups.push(() => {
          clearInterval(timer);
        });
      },
    },
    onState,
    onOpened
  );

/**
 * Runs `screen` (the draft's first when none is named) of the chat's
 * draft of `app` in `frame`, as a preview, and tells the chat's agent
 * once it rendered (`runFrame`).
 */
export const runPreview = (
  frame: HTMLIFrameElement,
  { chatId, app, screen }: { chatId: string; app: string; screen?: string },
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
): (() => void) =>
  runFrame(
    frame,
    {
      open: async (session) => await session.chats.preview(chatId, app, screen),
      target: (link, bundle) => previewTarget(link, chatId, bundle),
      running: (link, { app: id, revision, screen: shown }, cleanups) => {
        const tell = async (): Promise<void> => {
          try {
            const session = await link.session();
            await session.chats.previewReport(chatId, id, revision, shown);
          } catch {
            // Not told: the agent's check finds the preview unseen.
          }
        };
        const timer = setTimeout(() => {
          void tell();
        }, renderedAfterMs);
        cleanups.push(() => {
          clearTimeout(timer);
        });
      },
    },
    onState,
    onOpened
  );
