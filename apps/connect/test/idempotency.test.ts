import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  addConnection,
  agentFor,
  appFor,
  callAs,
  capabilityFor,
  outcome,
  serverUrl,
} from "./connect.ts";
import type { Call } from "./connect.ts";
import { fakeMcpServer } from "./mcp-server.ts";

// A side effect happens once per idempotency key, however often the call is
// repeated, retried or replayed. Keys are chosen by App and agent code, so
// a key only ever reaches its own subject's result for the same action,
// connection and input.

let sent = 0;
let rateLimited = false;
/** Holds `mail.archive` until the test lets it finish. */
let archiveDone: Promise<unknown> = Promise.resolve();

const server = fakeMcpServer(serverUrl, [
  {
    name: "mail.send",
    run: ({ to }) => {
      sent += 1;
      return { output: { messageId: `sent-${sent}`, to } };
    },
  },
  {
    name: "mail.forward",
    run: () =>
      rateLimited
        ? { output: { error: "Too many requests" }, isError: true }
        : { output: { forwarded: true } },
  },
  {
    name: "mail.archive",
    run: async () => {
      await archiveDone;
      return { output: { archived: true } };
    },
  },
  {
    name: "mail.draft",
    run: () => ({ output: { draftId: "draft-1" } }),
  },
  {
    name: "mail.list",
    readOnly: true,
    run: () => ({ output: { messages: [] } }),
  },
]);

const anna = agentFor("user-anna");

const send = (connectionId: string, idempotencyKey?: string): Call => ({
  connectionId,
  action: "mail.send",
  input: { to: "ben@acme.test" },
  idempotencyKey,
});

describe("a side effect", () => {
  it("is refused without an idempotency key, before anything is sent", async () => {
    const connectionId = await addConnection();
    await expect(outcome(callAs(anna, send(connectionId)))).resolves.toBe(
      "connect.idempotency_key_required"
    );
    expect(server.ran).toStrictEqual([]);
  });

  it("repeated with its key returns the first result without calling out", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    const first = await callAs(anna, call);
    const requestsBefore = server.requests;
    const repeat = await callAs(anna, call);
    expect(repeat).toStrictEqual(first);
    expect(server.ran).toHaveLength(1);
    // Not even a look at the server's tools.
    expect(server.requests).toBe(requestsBefore);
  });

  it("replayed with the same capability returns the first result", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    const capability = await capabilityFor(anna, call);
    const first = await exports.default.call({ ...call, capability });
    const replayed = await exports.default.call({ ...call, capability });
    expect(replayed).toStrictEqual(first);
    expect(server.ran).toHaveLength(1);
  });

  it("with another subject's key runs as its own call and never sees theirs", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "shared-key");
    const subjects = [
      anna,
      agentFor("user-anna", "agent-other"),
      appFor("user-anna", "agent-chat"),
    ];
    const results = await Promise.all(
      subjects.map(async (subject) => await callAs(subject, call))
    );
    expect(new Set(results.map((result) => result.output)).size).toBe(3);
    expect(server.ran).toHaveLength(3);
  });

  it("for another person, with the same key and input, runs as their own call", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    const forAnna = await callAs(anna, call);
    const forBen = await callAs(agentFor("user-ben"), call);
    expect(forBen.output).not.toBe(forAnna.output);
    expect(server.ran).toHaveLength(2);
  });

  it("with a key used for another action or connection runs as its own call", async () => {
    const connectionId = await addConnection();
    const otherConnection = await addConnection();
    await callAs(anna, send(connectionId, "key-1"));
    const draft = await callAs(anna, {
      connectionId,
      action: "mail.draft",
      input: { to: "ben@acme.test" },
      idempotencyKey: "key-1",
    });
    const elsewhere = await callAs(anna, send(otherConnection, "key-1"));
    expect(JSON.parse(draft.output)).toStrictEqual({ draftId: "draft-1" });
    expect(JSON.parse(elsewhere.output)).toHaveProperty("to", "ben@acme.test");
    expect(server.ran.map(({ tool }) => tool)).toStrictEqual([
      "mail.send",
      "mail.draft",
      "mail.send",
    ]);
  });

  it("is refused when its key was used for a different input", async () => {
    const connectionId = await addConnection();
    await callAs(anna, send(connectionId, "key-1"));
    const other = {
      ...send(connectionId, "key-1"),
      input: { to: "ceo@acme.test" },
    };
    await expect(outcome(callAs(anna, other))).resolves.toBe(
      "connect.idempotency_conflict"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("that may have run before its answer was lost is never sent again", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    server.network = "drop";
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.outcome_unknown"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("that the server turned away can be retried with its key", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    server.network = "unauthorised";
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.server_unavailable"
    );
    await expect(outcome(callAs(anna, call))).resolves.toBe("ok");
    expect(server.ran).toHaveLength(1);
  });

  it("that the tool reported as failed answers a repeat with that error", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.forward",
      input: {},
      idempotencyKey: "run-1:forward",
    };
    rateLimited = true;
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.action_failed"
    );
    // The tool may have acted before it failed: never run it again.
    rateLimited = false;
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.action_failed"
    );
    expect(server.ran).toHaveLength(1);
  });

  it("running at the same time as a repeat runs once", async () => {
    const connectionId = await addConnection();
    const call = send(connectionId, "run-1:send");
    const ends = await Promise.all([
      outcome(callAs(anna, call)),
      outcome(callAs(anna, call)),
    ]);
    expect(ends).toContain("ok");
    expect(
      ends.every((end) => end === "ok" || end === "connect.call_in_progress")
    ).toBeTruthy();
    expect(server.ran).toHaveLength(1);
  });
});

describe("a side effect whose call never came back", () => {
  it("holds its key while it may still be running, then never runs again", async () => {
    const connectionId = await addConnection();
    const call = {
      connectionId,
      action: "mail.archive",
      input: {},
      idempotencyKey: "run-1:archive",
    };
    const { promise, resolve } = Promise.withResolvers<boolean>();
    archiveDone = promise;
    // The first call is out at the server, as when connect died mid-call.
    const first = outcome(callAs(anna, call));
    await vi.waitUntil(() => server.ran.length === 1);
    await expect(outcome(callAs(anna, call))).resolves.toBe(
      "connect.call_in_progress"
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      await expect(outcome(callAs(anna, call))).resolves.toBe(
        "connect.outcome_unknown"
      );
    } finally {
      vi.useRealTimers();
      resolve(true);
    }
    await expect(first).resolves.toBe("ok");
    expect(server.ran).toHaveLength(1);
  });
});

describe("a read", () => {
  it("needs no idempotency key", async () => {
    const connectionId = await addConnection();
    await expect(
      outcome(callAs(anna, { connectionId, action: "mail.list", input: {} }))
    ).resolves.toBe("ok");
  });
});
