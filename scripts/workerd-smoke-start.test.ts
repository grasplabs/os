import { EventEmitter } from "node:events";

import { describe, expect, it } from "vite-plus/test";

import { coreStarted, isCoreHealth } from "./workerd-smoke-start.ts";
import type { HealthPoll, WorkerdProcess } from "./workerd-smoke-start.ts";

/** Core's own health answer, as core sends it. */
const coreHealth = (): Response =>
  Response.json({ ok: true }, { headers: { "x-request-id": "request-1" } });

/** A workerd process that exits when told to. */
// oxlint-disable-next-line unicorn/prefer-event-target -- it stands in for Node's ChildProcess, an EventEmitter
class FakeWorkerd extends EventEmitter implements WorkerdProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

/** A health poll whose every request `answer` answers. */
const pollWith = (answer: () => Promise<Response>): HealthPoll => ({
  url: "http://127.0.0.1:8790/health",
  headers: {},
  fetch: answer,
  attempts: 3,
  retryDelayMs: 0,
});

describe("the workerd smoke run", () => {
  it("takes core's own health answer", async () => {
    await expect(isCoreHealth(coreHealth())).resolves.toBeTruthy();
  });

  it("refuses another server's 200, without core's request ID or with another body", async () => {
    const answers = [
      Response.json({ ok: true }),
      Response.json(
        { ok: true, registered: true },
        { headers: { "x-request-id": "request-1" } }
      ),
    ];
    await expect(
      Promise.all(answers.map(async (answer) => await isCoreHealth(answer)))
    ).resolves.toStrictEqual([false, false]);
  });

  it("fails with workerd's exit code when workerd exits before core answers", async () => {
    const workerd = new FakeWorkerd();
    // Nothing ever answers, so only the exit settles it.
    const started = coreStarted(
      workerd,
      pollWith(async () => await Promise.withResolvers<Response>().promise)
    );
    workerd.exit(1);
    await expect(started).rejects.toThrow(
      "workerd exited (1) before core answered"
    );
  });

  it("fails when another server answers first", async () => {
    await expect(
      coreStarted(
        new FakeWorkerd(),
        pollWith(async () => await Promise.resolve(Response.json({ ok: true })))
      )
    ).rejects.toThrow("something other than core answers");
  });

  it("starts once core answers, while workerd runs", async () => {
    let requests = 0;
    const poll = pollWith(async () => {
      requests += 1;
      // Not listening yet on the first request.
      if (requests === 1) {
        throw new TypeError("fetch failed");
      }
      return await Promise.resolve(coreHealth());
    });
    await expect(coreStarted(new FakeWorkerd(), poll)).resolves.toBeUndefined();
  });
});
