import { describe, expect, it } from "vite-plus/test";
import { ZodError } from "zod";

import { auditEventSchema, auditLogger } from "../src/audit.ts";
import type { AuditEvent } from "../src/audit.ts";

/** A queue that keeps what it was sent. */
const memoryQueue = () => {
  const sent: AuditEvent[] = [];
  return {
    sent,
    send: async (event: AuditEvent) => {
      await Promise.resolve();
      sent.push(event);
    },
  };
};

describe("audit logger", () => {
  it("sends a valid event stamped with a new ID, the time and its own Worker", async () => {
    const queue = memoryQueue();
    const { log } = auditLogger(queue, "connect");

    const first = await log({ actor: { type: "system" }, action: "a" });
    const second = await log({ actor: { type: "system" }, action: "b" });

    expect(queue.sent).toStrictEqual([first, second]);
    expect(auditEventSchema.parse(first)).toStrictEqual(first);
    expect(first.source).toBe("connect");
    expect(first.id).not.toBe(second.id);
  });

  it("ignores an ID, time or source the caller tries to set", async () => {
    const queue = memoryQueue();
    const forged = {
      actor: { type: "system" },
      action: "a",
      id: "00000000-0000-4000-8000-000000000000",
      at: "2000-01-01T00:00:00Z",
      source: "core",
    } as const;

    const event = await auditLogger(queue, "connect").log(forged);

    expect(event.id).not.toBe(forged.id);
    expect(event.at).not.toBe(forged.at);
    expect(event.source).toBe("connect");
  });

  it("refuses a malformed event before it reaches the queue", async () => {
    const queue = memoryQueue();
    await expect(
      auditLogger(queue, "core").log({
        actor: { type: "system" },
        action: "model.call",
        cost: { amount: -1, currency: "usd" },
      })
    ).rejects.toThrow(ZodError);
    expect(queue.sent).toStrictEqual([]);
  });

  it("keeps content out of detail: only short, flat values", async () => {
    const queue = memoryQueue();
    const { log } = auditLogger(queue, "core");
    const entry = { actor: { type: "system" }, action: "model.call" } as const;

    await expect(
      log({ ...entry, detail: { status: "ok", attempt: 2, cached: false } })
    ).resolves.toMatchObject({ detail: { status: "ok" } });
    await expect(
      log({ ...entry, detail: { prompt: "x".repeat(10_000) } })
    ).rejects.toThrow(ZodError);
    await expect(
      // @ts-expect-error -- nested values are not allowed
      log({ ...entry, detail: { response: { text: "Dear team" } } })
    ).rejects.toThrow(ZodError);
    expect(queue.sent).toHaveLength(1);
  });
});
