import { newMessagePortRpcSession, RpcStub, RpcTarget } from "capnweb";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { connectBridge } from "../src/screen-runtime.ts";
import { callServer, live } from "../src/screen.ts";

// `live` from the side of the page: the screen's runtime connects to a fake
// page over a real `MessagePort`, as in the frame, and the page plays core
// and the App's server. It keeps each callback the screen passes, as a
// server that sends updates does, and lets go of it as a dropped
// connection does.

type Callback = (value: unknown) => Promise<void>;

/** A callback the screen passed, as the page receives it. */
const isCallback = (value: unknown): value is RpcStub<Callback> =>
  value instanceof RpcStub;

/** The page's side of the bridge, keeping each callback a call ends with. */
class FakePage extends RpcTarget {
  readonly subscriptions: { args: unknown[]; callback: RpcStub<Callback> }[] =
    [];

  call(method: string, args: unknown[]): string {
    const last = args.at(-1);
    if (method === "watchNotes" && isCallback(last)) {
      this.subscriptions.push({
        args: args.slice(0, -1),
        callback: last.dup(),
      });
    }
    return "answered";
  }
}

/**
 * Waits until everything the screen sent before now has reached the page,
 * and the page's messages before now have reached the screen: a round trip
 * over the same port, which keeps messages in order.
 */
const roundTrip = async (): Promise<void> => {
  await callServer("ping");
};

describe(live, () => {
  let page: FakePage;
  let sessions: Disposable[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { port1, port2 } = new MessageChannel();
    page = new FakePage();
    sessions = [newMessagePortRpcSession(port2, page), connectBridge(port1)];
  });

  afterEach(() => {
    for (const session of sessions) {
      session[Symbol.dispose]();
    }
    vi.useRealTimers();
  });

  /** The callback of the page's `index`th subscription. */
  const callbackAt = (index: number): RpcStub<Callback> => {
    const subscription = page.subscriptions[index];
    if (!subscription) {
      throw new Error(`No subscription ${index}`);
    }
    return subscription.callback;
  };

  it("passes on what the server sends until stopped, then rejects it, so the server lets go", async () => {
    const received: unknown[] = [];
    const stop = live("watchNotes", ["open"], (value) => {
      received.push(value);
    });
    await roundTrip();
    await callbackAt(0)(["Call Acme"]);

    stop();
    const afterStop = await callbackAt(0)(["Too late"]).then(
      () => "delivered",
      () => "rejected"
    );
    // The server lets go of a callback that rejects; no new one follows.
    callbackAt(0)[Symbol.dispose]();
    await roundTrip();
    await vi.advanceTimersByTimeAsync(60_000);
    await roundTrip();

    expect({
      args: page.subscriptions.map(({ args }) => args),
      received,
      afterStop,
    }).toStrictEqual({
      args: [["open"]],
      received: [["Call Acme"]],
      afterStop: "rejected",
    });
  });

  it("subscribes again, backing off, when its callback is let go, and never once stopped", async () => {
    const stop = live("watchNotes", [], () => {
      // Nothing to update.
    });
    await roundTrip();

    /** Drops the latest callback, and counts subscriptions `ms` later. */
    const dropAndWait = async (ms: number): Promise<number> => {
      callbackAt(page.subscriptions.length - 1)[Symbol.dispose]();
      await roundTrip();
      await vi.advanceTimersByTimeAsync(ms);
      await roundTrip();
      return page.subscriptions.length;
    };

    const afterFirstSecond = await dropAndWait(1000);
    const beforeTwoSeconds = await dropAndWait(1999);
    await vi.advanceTimersByTimeAsync(1);
    await roundTrip();
    const afterTwoSeconds = page.subscriptions.length;

    // Stopped while waiting to subscribe again: it never does.
    callbackAt(page.subscriptions.length - 1)[Symbol.dispose]();
    await roundTrip();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    await roundTrip();

    expect({
      afterFirstSecond,
      beforeTwoSeconds,
      afterTwoSeconds,
      afterStop: page.subscriptions.length,
    }).toStrictEqual({
      afterFirstSecond: 2,
      beforeTwoSeconds: 2,
      afterTwoSeconds: 3,
      afterStop: 3,
    });
  });
});
