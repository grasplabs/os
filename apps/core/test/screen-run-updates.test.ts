import { appIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appHost } from "../src/durable-objects.ts";
import { approvalApp, week } from "./decisions.ts";
import type { Person } from "./decisions.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns } from "./runs.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Run status, live: a screen follows its App's runs of a workflow
// (`screens.watchRuns`), and core tells it each time one starts, waits for
// a decision, has it answered, or ends, so it reads them again. The ways
// this could go wrong, tried below: pushes reaching someone who has lost
// their role in the App, a subscription to an App they have none in, a
// screen piling up subscriptions, and one screen that fails stopping the
// others' pushes.

const idp = mockIdp();

const personApi = async (role: "admin" | "builder" | "user") =>
  await signedInApi(idp, role);

/**
 * `value` as whatever a call takes: what a page made to pass on anything
 * can send, which core must refuse.
 */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; Cap'n Web checks no types, so core must.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** A decision any admin answers, for a week. */
const byAdmins = { from: "role:admin", timeout: week };

/** How long a push may take to arrive, and how often to look. */
const pushWait = { timeout: 20_000, interval: 50 };

/**
 * A screen's callback: what reaches it, and whether core let it go (Cap'n
 * Web disposes a callback once nothing can call it any more).
 */
const follower = (fails = false) => {
  const received: unknown[] = [];
  const state = { released: false };
  const callback = Object.assign(
    (change: unknown): void => {
      received.push(change);
      if (fails) {
        throw new Error("This screen is gone");
      }
    },
    {
      [Symbol.dispose]: (): void => {
        state.released = true;
      },
    }
  );
  return { received, state, callback };
};

/** Once more than `seen` pushes have reached `received`. */
const pushedAfter = async (
  received: unknown[],
  seen: number
): Promise<void> => {
  await vi.waitFor(() => {
    if (received.length <= seen) {
      throw new Error(`${received.length} pushes so far`);
    }
  }, pushWait);
};

/**
 * A screen of `app` that follows its runs of `workflow` and reads the one
 * a push names again, as `useWorkflow` does, and never otherwise: what it
 * saw, it saw because of a push.
 */
const readingScreen = async (
  person: Person,
  app: string,
  workflow = "approval"
) => {
  const pushes: unknown[] = [];
  const seen: string[] = [];
  const read = async (change: unknown): Promise<void> => {
    const run =
      typeof change === "object" && change !== null && "run" in change
        ? String(change.run)
        : "";
    try {
      const { id, status } = await person.api.screens.run(app, run);
      seen.push(`${id} ${status}`);
    } catch {
      seen.push(`${run} unreadable`);
    }
  };
  await person.api.screens.watchRuns(app, workflow, (change: unknown) => {
    pushes.push(change);
    void read(change);
  });
  return {
    pushes,
    /** Once a read after a push found `run` in `status`. */
    saw: async (run: string, status: string): Promise<void> => {
      await vi.waitFor(() => {
        expect(seen).toContain(`${run} ${status}`);
      }, pushWait);
    },
    /**
     * Once a read after a push found `run` in `status`, after one found it
     * in `before`.
     */
    sawAfter: async (
      run: string,
      before: string,
      status: string
    ): Promise<void> => {
      await vi.waitFor(() => {
        const first = seen.indexOf(`${run} ${before}`);
        expect(first).toBeGreaterThanOrEqual(0);
        expect(seen.slice(first + 1)).toContain(`${run} ${status}`);
      }, pushWait);
    },
  };
};

/** Tells the App's screens following `approval` that a run changed. */
const nudge = async (app: string): Promise<void> => {
  await appHost(env, appIdSchema.parse(app)).runChanged("approval", "nudge");
};

describe("run status on screens", { timeout: 60_000 }, () => {
  afterEach(endLiveRuns);

  it("tells a screen when a run waits for a decision and when it ends, so it shows each without asking", async () => {
    const builder = await personApi("builder");
    const admin = await personApi("admin");
    const app = await approvalApp(builder);
    const screen = await readingScreen(admin, app);

    const { id: run } = await builder.api.screens.startRun(
      app,
      "approval",
      byAdmins
    );
    await screen.saw(run, "waiting");
    await admin.api.screens.decide(app, run, "review", { approved: true });
    await screen.saw(run, "completed");

    expect({
      ended: await admin.api.screens.run(app, run),
      // Each push only says which run changed: the screen reads it again,
      // as the person, with what they may see of it.
      pushes: new Set(screen.pushes.map((change) => JSON.stringify(change))),
    }).toMatchObject({
      ended: { status: "completed", waitingFor: [] },
      pushes: new Set([JSON.stringify({ run })]),
    });
  });

  it("tells a screen when a run fails", async () => {
    const builder = await personApi("builder");
    // Its one step calls a method the App doesn't have, which no retry
    // fixes; its test mocks the step, so it passes activation.
    const app = await appWith(
      builder,
      workflowFiles(
        "failing",
        `  return await step.do("work", { description: "Work", retries: { limit: 0 } }, async () => await env.APP.call("missing"));`,
        { work: 1 }
      )
    );
    const screen = await readingScreen(builder, app, "failing");

    const { id: run } = await builder.api.screens.startRun(app, "failing");

    await expect(screen.saw(run, "failed")).resolves.toBeUndefined();
  });

  it("tells a screen when a decision closes, timed out, and the run goes on", async () => {
    const builder = await personApi("builder");
    // The decision times out as the decision tests' own does, after a
    // short deadline; then the run waits for an event, so it goes on
    // without ending, and only the closed decision can tell the screen.
    const app = await appWith(
      builder,
      workflowFiles(
        "expiring",
        `  await step.decision("review", { description: "Approve", from: "person:${builder.userId}", ask: async () => {}, timeout: 1500 });
  await step.waitFor("go", { description: "Wait", type: "go", timeout: "1 day" });
  return 1;`
      )
    );
    const screen = await readingScreen(builder, app, "expiring");

    const { id: run } = await builder.api.screens.startRun(app, "expiring");
    await screen.sawAfter(run, "waiting", "running");

    await expect(builder.api.screens.run(app, run)).resolves.toMatchObject({
      status: "running",
      waitingFor: [],
    });
  });

  it("tells a screen when a builder cancels a run", async () => {
    const builder = await personApi("builder");
    const app = await approvalApp(builder);
    const screen = await readingScreen(builder, app);
    const { id: run } = await builder.api.screens.startRun(
      app,
      "approval",
      byAdmins
    );
    await screen.saw(run, "waiting");

    await builder.api.workflows.cancel(run);

    await expect(screen.saw(run, "cancelled")).resolves.toBeUndefined();
  });

  it("stops pushing to someone unshared within seconds, and lets their screen go", async () => {
    const owner = await personApi("builder");
    const member = await personApi("builder");
    const app = await approvalApp(owner);
    const them = { type: "person", id: member.userId } as const;
    await owner.api.apps.members.add(app, { ...them, role: "user" });
    const screen = follower();
    await member.api.screens.watchRuns(app, "approval", screen.callback);
    await nudge(app);
    await pushedAfter(screen.received, 0);

    await owner.api.apps.members.remove(app, them);
    // Their access is checked again at most every few seconds: a push
    // before that may still reach them, and the first after it doesn't.
    await vi.waitFor(
      async () => {
        await nudge(app);
        if (!screen.state.released) {
          throw new Error("Still following");
        }
      },
      { timeout: 15_000, interval: 500 }
    );
    const received = screen.received.length;
    await nudge(app);
    await nudge(app);

    expect({
      more: screen.received.length - received,
      again: await outcome(
        member.api.screens.watchRuns(app, "approval", follower().callback)
      ),
    }).toStrictEqual({ more: 0, again: "app.not_found" });
  });

  it("lets a screen go when the App's host restarts, so it follows again and hears on", async () => {
    const builder = await personApi("builder");
    const app = await approvalApp(builder);
    const before = follower();
    await builder.api.screens.watchRuns(app, "approval", before.callback);

    // Restarted, as a deploy restarts it: it holds the screen's callback,
    // so the runtime won't just evict it.
    await runInDurableObject(
      appHost(env, appIdSchema.parse(app)),
      (_host, state) => {
        state.abort("Restarted by the test");
      }
    ).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    await vi.waitFor(() => {
      if (!before.state.released) {
        throw new Error("Still kept");
      }
    }, pushWait);
    // What the SDK does once its callback is let go.
    const after = follower();
    await builder.api.screens.watchRuns(app, "approval", after.callback);
    await nudge(app);
    await pushedAfter(after.received, 0);

    expect({
      before: before.received.length,
      after: after.received.length,
    }).toStrictEqual({
      before: 0,
      after: 1,
    });
  });

  it("drops a screen whose callback fails, and keeps telling the others", async () => {
    const builder = await personApi("builder");
    const app = await approvalApp(builder);
    const gone = follower(true);
    const open = follower();
    await builder.api.screens.watchRuns(app, "approval", gone.callback);
    await builder.api.screens.watchRuns(app, "approval", open.callback);

    await nudge(app);
    await vi.waitFor(() => {
      if (!gone.state.released) {
        throw new Error("Still kept");
      }
    }, pushWait);
    await pushedAfter(open.received, 0);
    const received = open.received.length;
    await nudge(app);
    await pushedAfter(open.received, received);

    expect({
      gone: gone.received.length,
      open: open.received.length,
    }).toStrictEqual({
      gone: 1,
      open: received + 1,
    });
  });

  it("frees a subscription's slot once the screen releases it, and pushes nothing more to it", async () => {
    const builder = await personApi("builder");
    const app = await approvalApp(builder);
    const screens = Array.from({ length: 20 }, () => follower());
    const subscriptions = await Promise.all(
      screens.map(
        async ({ callback }) =>
          await builder.api.screens.watchRuns(app, "approval", callback)
      )
    );
    const full = await outcome(
      builder.api.screens.watchRuns(app, "approval", follower().callback)
    );
    const [released] = screens;
    await subscriptions[0]?.release();
    // Released again, or once more by the screen letting go: nothing more.
    await subscriptions[0]?.release();
    const latest = follower();
    const freed = await outcome(
      builder.api.screens.watchRuns(app, "approval", latest.callback)
    );
    await nudge(app);
    await pushedAfter(latest.received, 0);

    expect({
      full,
      freed,
      releasedLetGo: released?.state.released,
      releasedGot: released?.received.length,
      latestGot: latest.received.length,
    }).toStrictEqual({
      full: "screen.too_many_subscriptions",
      freed: "ok",
      releasedLetGo: true,
      releasedGot: 0,
      latestGot: 1,
    });
  });

  it("refuses to follow runs without a role in the App, of a name that isn't a workflow, or more than a screen needs", async () => {
    const builder = await personApi("builder");
    const stranger = await personApi("builder");
    const app = await approvalApp(builder);

    const stranded = await outcome(
      stranger.api.screens.watchRuns(app, "approval", follower().callback)
    );
    const invalidName = await outcome(
      builder.api.screens.watchRuns(app, unchecked(7), follower().callback)
    );
    const notCallback = await outcome(
      builder.api.screens.watchRuns(app, "approval", unchecked("callback"))
    );
    // One connection is one open screen: it follows at most 20 at once.
    const followed = await Promise.all(
      Array.from(
        { length: 20 },
        async () =>
          await outcome(
            builder.api.screens.watchRuns(app, "approval", follower().callback)
          )
      )
    );
    const tooMany = await outcome(
      builder.api.screens.watchRuns(app, "approval", follower().callback)
    );

    expect({
      stranded,
      invalidName,
      notCallback,
      followed: new Set(followed),
      tooMany,
    }).toStrictEqual({
      stranded: "app.not_found",
      invalidName: "workflow.invalid",
      notCallback: "screen.invalid",
      followed: new Set(["ok"]),
      tooMany: "screen.too_many_subscriptions",
    });
  });
});
