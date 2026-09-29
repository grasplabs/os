import { RpcStub } from "capnweb";

import { isPlainData } from "./app.ts";

// Callbacks a page passes over `/rpc` for an object to keep and call later:
// a screen's for its App (screens-rpc.ts), a chat page's for the chat's
// Workspace object (chats-rpc.ts). The object gets a function that passes
// plain data on and nothing back, and that checks before each push that
// the person may still have it.

/** Whether the person may still get a callback's pushes, read now. */
export type StillOpen = () => Promise<boolean>;

/** A function (or object) of the page's, which the object may only call. */
export type PageCallback = RpcStub<(value: unknown) => unknown>;

/** A stub of the page's: a function or object it passed. */
export const isStub = (value: unknown): value is PageCallback =>
  value instanceof RpcStub;

/** How a push is refused: data that isn't plain, or a person who may no longer have it. */
export interface Refusals {
  invalid: () => Error;
  closed: () => Error;
}

/**
 * The page's callback `stub` as a function an object can keep and call
 * later: it passes on plain data only, never a way into the object, and
 * gives it nothing back from the page. It's released by the runtime once
 * the object lets it go, or by its owner; releasing it twice does nothing.
 * Releasing it releases the page's stub too, which tells the page to
 * subscribe again. Before each push, `stillOpen` checks the person may
 * still have it; once they may not, it releases itself and refuses the
 * push, and every one after. `released`, if given, is called once it's
 * released, however that happened.
 */
export const callbackFor = (
  stub: PageCallback,
  stillOpen: StillOpen,
  refusals: Refusals,
  released?: () => void
): ((value: unknown) => Promise<void>) & Disposable => {
  const toPage = stub.dup();
  let live = true;
  const release = (): void => {
    if (!live) {
      return;
    }
    live = false;
    toPage[Symbol.dispose]();
    released?.();
  };
  return Object.assign(
    async (value: unknown): Promise<void> => {
      if (!isPlainData(value)) {
        throw refusals.invalid();
      }
      if (!live || !(await stillOpen())) {
        release();
        throw refusals.closed();
      }
      try {
        await toPage(value);
      } catch (error) {
        // The page didn't take it (gone, or its callback failed): whoever
        // pushes drops the callback, and its slot is free again.
        release();
        throw error;
      }
    },
    { [Symbol.dispose]: release }
  );
};

/**
 * `open`, asked again at most every `ms` and shared by every push
 * meanwhile: so a stream of pushes costs a check every few seconds, not
 * one each.
 */
export const recheckedEvery = (
  ms: number,
  open: () => Promise<boolean>
): StillOpen => {
  let cached: { open: Promise<boolean>; until: number } | undefined;
  return async () => {
    const now = Date.now();
    if (cached === undefined || cached.until <= now) {
      cached = { open: open(), until: now + ms };
    }
    return await cached.open;
  };
};
