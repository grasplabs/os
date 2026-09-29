/**
 * What an App's screens use to reach their App's server, from inside their
 * sandboxed frame. A screen has no network: these calls go through the
 * page around it, to core, which checks the person's session and role on
 * every one and runs the method as that person.
 *
 * ```tsx
 * import { callServer, useLive } from "@grasp-os/sdk/screen";
 *
 * export default function Notes() {
 *   const notes = useLive<string[]>("watchNotes", []);
 *   return (
 *     <Button onClick={() => void callServer("addNote", "Call Acme")}>Add</Button>
 *   );
 * }
 * ```
 *
 * Live updates: a server method that takes a callback as its last argument
 * keeps it, calls it with the current value, and calls it again whenever
 * the value changes, for everyone who has the screen open. The callback in
 * the arguments ends with the call, so the server keeps a duplicate, and
 * drops it once calling it fails (the screen is gone, or stopped
 * listening):
 *
 * ```ts
 * export class App extends DurableObject {
 *   #watchers = new Set<Watcher>();
 *
 *   watchNotes(_caller: Caller, onChange: Watcher): void {
 *     const watcher = onChange.dup();
 *     this.#watchers.add(watcher);
 *     void this.#send(watcher, this.notes());
 *   }
 *
 *   addNote(_caller: Caller, note: string): void {
 *     this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", note);
 *     for (const watcher of this.#watchers) {
 *       void this.#send(watcher, this.notes());
 *     }
 *   }
 *
 *   async #send(watcher: Watcher, notes: string[]): Promise<void> {
 *     try {
 *       await watcher(notes);
 *     } catch {
 *       this.#watchers.delete(watcher);
 *       watcher[Symbol.dispose]();
 *     }
 *   }
 * }
 * ```
 *
 * A screen subscribes again by itself when its connection drops and comes
 * back, so the server sees a new callback then. Values passed to a
 * callback, like answers, must be plain data.
 *
 * Workflows: `useWorkflow("invoice-intake")` starts runs of the App's
 * workflow, shows them as they change (started, waiting for a decision,
 * ended) and answers their decisions, for the person using the screen;
 * `useRun("invoice-intake", id)` follows one run by its ID, however old. A
 * workflow saves what it finds by calling the App's server
 * (`appServer<App>(env)` in `@grasp-os/sdk/workflow`), which tells the
 * screens that have it open, as above.
 */
import { useEffect, useState } from "react";

import { bridge } from "./screen-runtime.ts";

/**
 * Calls `method` of the App's server with `args`, for the person using the
 * screen, and resolves with its answer. Rejects when the server refuses or
 * fails; the error's `code` says why (`app.failed` for the App's own).
 */
export const callServer = async <Answer = unknown>(
  method: string,
  ...args: unknown[]
): Promise<Answer> => {
  const answer: unknown = await bridge().call(method, args);
  // SAFETY: the answer's shape is the App's own contract between its server
  // and its screens; the platform only guarantees it is plain data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return answer as Answer;
};

/** How long to wait before subscribing again, at first and at most. */
const retryMs = { first: 1000, most: 30_000 };

/**
 * Subscribes with `subscribe`, which passes the listener it's given on to
 * core: `onChange` gets every value core sends it, and `onSubscribed` runs
 * each time a subscription is made. When the connection drops, it
 * subscribes again once it is back, backing off to every 30 s. Returns a
 * function that stops it; once stopped, the callback rejects whatever
 * core sends it next, so core drops it.
 */
const follow = (
  what: string,
  subscribe: (listener: (value: unknown) => void) => Promise<unknown>,
  onChange: (value: unknown) => void,
  onSubscribed?: () => void
): (() => void) => {
  let stopped = false;
  let delay = retryMs.first;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const again = async (): Promise<void> => {
    retry = undefined;
    if (stopped) {
      return;
    }
    // Cap'n Web disposes a callback once nothing can call it any more: the
    // connection to core dropped, the subscription failed, or the server
    // dropped it after it rejected a value.
    const callback = Object.assign(
      (value: unknown): void => {
        if (stopped) {
          throw new Error(`The subscription to ${what} has stopped.`);
        }
        delay = retryMs.first;
        onChange(value);
      },
      {
        [Symbol.dispose]: (): void => {
          if (!stopped) {
            retry = setTimeout(() => {
              void again();
            }, delay);
            delay = Math.min(delay * 2, retryMs.most);
          }
        },
      }
    );
    try {
      await subscribe(callback);
      if (!stopped) {
        onSubscribed?.();
      }
    } catch (error) {
      // The screen's own error: the runtime reports it to the error log.
      console.error(`Subscribing to ${what} failed`, error);
    }
  };
  void again();
  return () => {
    stopped = true;
    clearTimeout(retry);
  };
};

/**
 * Subscribes to a server method that sends updates (see above): calls
 * `method` with `args` and a callback, which gets every value the server
 * sends. When the connection drops, subscribes again once it is back.
 * Returns a function that stops it.
 *
 * The method must keep its callback (`onChange.dup()`, see above). One
 * that lets it go releases it, which this reads as a dropped connection:
 * it subscribes again and again, backing off to every 30 s.
 *
 * Once stopped, the callback rejects whatever the server sends it next, so
 * the server drops it (see above).
 */
export const live = (
  method: string,
  args: readonly unknown[],
  onChange: (value: unknown) => void
): (() => void) =>
  follow(
    method,
    async (listener) => await bridge().call(method, [...args, listener]),
    onChange
  );

/**
 * The latest value a server method sent (see `live`), in a component:
 * `initial` until the first. `args` are plain data; a change in them
 * subscribes again.
 */
export const useLive = <Value>(
  method: string,
  initial: Value,
  ...args: unknown[]
): Value => {
  const [value, setValue] = useState(initial);
  const argsJson = JSON.stringify(args);
  useEffect(() => {
    const withArgs: unknown = JSON.parse(argsJson);
    return live(method, Array.isArray(withArgs) ? withArgs : [], (next) => {
      // SAFETY: as in `callServer`, the value is the App's own contract.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      setValue(next as Value);
    });
  }, [method, argsJson]);
  return value;
};

// The App's workflows

/** Where a run is: running, waiting for a decision or an event, paused, or ended. */
export type RunStatus =
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

/** A decision a run waits for. */
export interface WaitingDecision {
  /** Its name in the workflow (`step.decision(name, …)`): what `decide` takes. */
  name: string;
  /**
   * What it asks, as the workflow describes it: only for the run's starter,
   * admins, and whoever may answer it.
   */
  description?: string;
  /** Its deadline, ISO 8601: no answer counts after it. */
  expiresAt: string;
}

/** A run of one of the App's workflows. */
export interface WorkflowRun {
  id: string;
  workflow: string;
  /** The App version it runs. */
  version: number;
  /** A person started it (and it acts for them), or a trigger did. */
  startedBy: { type: "person"; userId: string } | { type: "trigger" };
  status: RunStatus;
  /** ISO 8601. */
  createdAt: string;
  endedAt: string | null;
  /** What it returned, once completed: only from `status`, for its starter and admins. */
  output?: unknown;
  /** Why it stopped, once failed: for its starter and admins. */
  failure?: {
    step: string | null;
    error: { code: string; message: string };
  };
}

/**
 * A run as a screen sees it: `waiting` while a decision of it is open, with
 * the decisions it waits for (none once it has ended).
 */
export interface ScreenRun extends WorkflowRun {
  waitingFor: WaitingDecision[];
}

/** A JSON value. */
export type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json | undefined };

/** An answer to a decision. */
export interface DecisionAnswer {
  approved: boolean;
  /** Anything more the workflow asks for, e.g. `{ comment }`: at most 4 KiB. */
  payload?: Json;
}

/** A subscription core answers `watchRuns` with, as the frame holds it. */
interface RunHold extends Disposable {
  release: () => Promise<void>;
}

/**
 * Releases `hold`, so core calls its callback no more and frees its slot
 * of the 20 a screen may hold. One that can't be released (the
 * connection dropped) is gone already: core let go of it with the
 * connection.
 */
const release = async (hold: RunHold): Promise<void> => {
  try {
    await hold.release();
  } catch {
    // Gone with its connection, as above.
  } finally {
    hold[Symbol.dispose]();
  }
};

/** A workflow the frame follows, and whoever follows it now. */
interface RunFollowing {
  listeners: Set<() => void>;
  stop: () => void;
}

/**
 * What the frame follows of its App's runs, by workflow: one subscription
 * to core each, shared by every screen component following that workflow
 * now, and released once the last stops. Components mount and unmount
 * often; core keeps at most 20 subscriptions per open screen, so they
 * share one, and none outlives its last follower.
 */
const runFollowers = new Map<string, RunFollowing>();

/** Follows `workflow` with a subscription of its own, until stopped. */
const followWorkflow = (workflow: string): RunFollowing => {
  const listeners = new Set<() => void>();
  let stopped = false;
  let held: RunHold | undefined;
  const tellAll = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };
  const stopFollowing = follow(
    `the runs of ${workflow}`,
    async (listener) => {
      const answer: unknown = await bridge().watchRuns(workflow, listener);
      // SAFETY: core's `screens.watchRuns` answers a subscription stub.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const hold = answer as RunHold;
      // Stopped while it subscribed: nobody follows it any more.
      if (stopped) {
        await release(hold);
        return;
      }
      // One before it went with its connection (following again).
      held?.[Symbol.dispose]();
      held = hold;
    },
    tellAll,
    tellAll
  );
  return {
    listeners,
    stop: () => {
      stopped = true;
      stopFollowing();
      if (held !== undefined) {
        void release(held);
        held = undefined;
      }
    },
  };
};

/**
 * Calls `onChange` each time core says one of the App's runs of `workflow`
 * changed, or it has followed that workflow again (and may have missed a
 * change meanwhile). Returns a function that stops calling it; the last
 * one to stop releases the workflow's subscription.
 */
const onRunChange = (workflow: string, onChange: () => void): (() => void) => {
  const following = runFollowers.get(workflow) ?? followWorkflow(workflow);
  runFollowers.set(workflow, following);
  following.listeners.add(onChange);
  return () => {
    following.listeners.delete(onChange);
    if (
      following.listeners.size === 0 &&
      runFollowers.get(workflow) === following
    ) {
      runFollowers.delete(workflow);
      following.stop();
    }
  };
};

/**
 * Follows the App's runs of `workflow`: calls `onRuns` with them, newest
 * first (at most 100), once it has read them and each time one of them
 * starts, waits for a decision, has it answered, or ends. Each time core
 * says a run changed, it reads them again, as the person, so what it
 * shows is never older than what it showed last, whatever order reads
 * come back in. A read that fails leaves the runs as they were and is
 * tried again, backing off to every 30 s, until it or a newer read
 * succeeds. Returns a function that stops it.
 */
export const followRuns = (
  workflow: string,
  onRuns: (runs: ScreenRun[]) => void
): (() => void) => {
  let stopped = false;
  let started = 0;
  let shown = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const read = async (delay: number): Promise<void> => {
    clearTimeout(retry);
    retry = undefined;
    started += 1;
    const mine = started;
    try {
      const runs: unknown = await bridge().runs(workflow);
      if (!stopped && mine > shown && Array.isArray(runs)) {
        shown = mine;
        // SAFETY: core's `screens.runs` answers `ScreenRun[]`.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        onRuns(runs as ScreenRun[]);
      }
    } catch (error) {
      console.error(`Reading the runs of ${workflow} failed`, error);
      // Tried again unless a newer read has started, which shows instead.
      if (!stopped && mine === started) {
        retry = setTimeout(() => {
          void read(Math.min(delay * 2, retryMs.most));
        }, delay);
      }
    }
  };
  const readNow = (): void => {
    void read(retryMs.first);
  };
  const stop = onRunChange(workflow, readNow);
  readNow();
  return () => {
    stopped = true;
    clearTimeout(retry);
    stop();
  };
};

/** What core answers for a run it has no record of. */
const runNotFound = "workflow.run_not_found";

const isRunNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === runNotFound;

/**
 * Follows one run of `workflow` by its ID: calls `onRun` with it once it
 * has read it and each time core says one of the workflow's runs changed,
 * however old the run is (`followRuns` lists the newest 100 only). With
 * `null` when core has no such run, or none the person may see. A read
 * that fails otherwise leaves it as it was and is tried again, backing off
 * to every 30 s, as `followRuns` does; a newer read always wins over an
 * older one. Returns a function that stops it.
 */
export const followRun = (
  workflow: string,
  run: string,
  onRun: (run: ScreenRun | null) => void
): (() => void) => {
  let stopped = false;
  let started = 0;
  let shown = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const show = (mine: number, found: ScreenRun | null): void => {
    if (!stopped && mine > shown) {
      shown = mine;
      onRun(found);
    }
  };
  const read = async (delay: number): Promise<void> => {
    clearTimeout(retry);
    retry = undefined;
    started += 1;
    const mine = started;
    try {
      const found: unknown = await bridge().run(run);
      // SAFETY: core's `screens.run` answers a `ScreenRun`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      show(mine, found as ScreenRun);
    } catch (error) {
      if (isRunNotFound(error)) {
        show(mine, null);
        return;
      }
      console.error(`Reading run ${run} of ${workflow} failed`, error);
      if (!stopped && mine === started) {
        retry = setTimeout(() => {
          void read(Math.min(delay * 2, retryMs.most));
        }, delay);
      }
    }
  };
  const readNow = (): void => {
    void read(retryMs.first);
  };
  const stop = onRunChange(workflow, readNow);
  readNow();
  return () => {
    stopped = true;
    clearTimeout(retry);
    stop();
  };
};

/**
 * One run of the App's workflow `workflow`, in a component, by its ID,
 * live (`followRun`): `undefined` until it is read, `null` when core has
 * no such run, or none the person may see.
 */
export const useRun = (
  workflow: string,
  run: string
): ScreenRun | null | undefined => {
  // Kept with the run it is of, so switching to another shows nothing of
  // the last one meanwhile.
  const [followed, setFollowed] = useState<{
    key: string;
    run: ScreenRun | null | undefined;
  }>({ key: `${workflow}/${run}`, run: undefined });
  useEffect(
    () =>
      followRun(workflow, run, (found) => {
        setFollowed({ key: `${workflow}/${run}`, run: found });
      }),
    [workflow, run]
  );
  return followed.key === `${workflow}/${run}` ? followed.run : undefined;
};

/**
 * One of the App's workflows, in a component, for the person using the
 * screen: its runs, live (`followRuns`), and what they can do with them.
 * Within one App no permission is needed; core checks the person's role in
 * the App on every call, and a decision's own rules decide who answers it.
 *
 * ```tsx
 * const intake = useWorkflow("invoice-intake");
 * <Button onClick={() => void intake.start({ invoice: "INV-7" })}>Start</Button>
 * {intake.runs.map((run) =>
 *   run.waitingFor.map((decision) => (
 *     <Button key={decision.name} onClick={() => void intake.decide(run.id, decision.name, { approved: true })}>
 *       Approve
 *     </Button>
 *   ))
 * )}
 * ```
 */
export const useWorkflow = (
  workflow: string
): {
  /** Its runs, newest first: empty until the first read. */
  runs: ScreenRun[];
  /** Starts a run with `input`, for the person. */
  start: (input?: unknown) => Promise<WorkflowRun>;
  /** A run as it is now, with what it returned for its starter and admins. */
  status: (run: string) => Promise<ScreenRun>;
  /**
   * Answers the run's decision `decision` (its name in the workflow), if
   * the person may: someone it is from, never the run's starter unless it
   * names exactly them. Rejects with `decision.forbidden` otherwise, and
   * with `decision.closed` once it's answered or past its deadline.
   */
  decide: (
    run: string,
    decision: string,
    answer: DecisionAnswer
  ) => Promise<void>;
} => {
  // Kept with the workflow they are of, so a screen that switches to
  // another workflow never shows the last one's runs meanwhile.
  const [followed, setFollowed] = useState<{
    workflow: string;
    runs: ScreenRun[];
  }>({ workflow, runs: [] });
  useEffect(
    () =>
      followRuns(workflow, (runs) => {
        setFollowed({ workflow, runs });
      }),
    [workflow]
  );
  return {
    runs: followed.workflow === workflow ? followed.runs : [],
    start: async (input) => {
      const run: unknown = await bridge().startRun(workflow, input);
      // SAFETY: core's `screens.startRun` answers a `WorkflowRun`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return run as WorkflowRun;
    },
    status: async (run) => {
      const found: unknown = await bridge().run(run);
      // SAFETY: core's `screens.run` answers a `ScreenRun`.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      return found as ScreenRun;
    },
    decide: async (run, decision, answer) => {
      await bridge().decide(run, decision, answer);
    },
  };
};
