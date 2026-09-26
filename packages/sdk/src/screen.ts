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
 * drops it once calling it fails (the screen is gone):
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
 * Subscribes to a server method that sends updates (see above): calls
 * `method` with `args` and a callback, which gets every value the server
 * sends. When the connection drops, subscribes again once it is back.
 * Returns a function that stops it.
 *
 * The method must keep its callback (`onChange.dup()`, see above). One
 * that lets it go releases it, which this reads as a dropped connection:
 * it subscribes again and again, backing off to every 30 s.
 */
export const live = (
  method: string,
  args: readonly unknown[],
  onChange: (value: unknown) => void
): (() => void) => {
  let stopped = false;
  let delay = retryMs.first;
  const subscribe = async (): Promise<void> => {
    // Cap'n Web disposes a callback once nothing can call it any more: the
    // connection to core dropped, or the subscription failed.
    const callback = Object.assign(
      (value: unknown): void => {
        delay = retryMs.first;
        if (!stopped) {
          onChange(value);
        }
      },
      {
        [Symbol.dispose]: (): void => {
          if (!stopped) {
            setTimeout(() => {
              void subscribe();
            }, delay);
            delay = Math.min(delay * 2, retryMs.most);
          }
        },
      }
    );
    try {
      await bridge().call(method, [...args, callback]);
    } catch (error) {
      // The screen's own error: the runtime reports it to the error log.
      console.error(`Subscribing with ${method} failed`, error);
    }
  };
  void subscribe();
  return () => {
    stopped = true;
  };
};

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
