import { connectErrors } from "@grasp-os/shared/connect";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addConnection,
  agentFor,
  callAs,
  capabilityFor,
  chatOrigin,
  outcome,
  serverUrl,
} from "./connect.ts";
import type { Call } from "./connect.ts";
import { fakeMcpServer } from "./mcp-server.ts";
import type { FakeTool } from "./mcp-server.ts";

// Which connection a call may reach and what it may do there: only a
// connection that is active, a personal one only for its owner, only the
// exact action the capability names, and only what connect can vouch for
// on a Composio server, whatever the server says about its own tools.

const messages = ["message-1", "message-2"];

const tools: FakeTool[] = [
  {
    name: "mail.list",
    readOnly: true,
    run: () => ({ output: { messages }, provenance: messages }),
  },
  {
    name: "mail.read",
    readOnly: true,
    resourceField: "mailbox",
    run: ({ mailbox }) => ({ output: { mailbox, messages } }),
  },
  {
    name: "mail.photo",
    run: () => ({
      output: {},
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    }),
  },
  {
    name: "mail.search",
    run: ({ query }) =>
      query === ""
        ? { output: { error: "An empty query" }, isError: true }
        : { output: { messages: [] } },
  },
];

const server = fakeMcpServer(serverUrl, tools);

const anna = agentFor("user-anna");
const ben = agentFor("user-ben");

/** A call of `action` with a fresh idempotency key. */
const write = (
  connectionId: string,
  action = "mail.list",
  input: Call["input"] = {}
): Call => ({
  connectionId,
  action,
  input,
  idempotencyKey: crypto.randomUUID(),
});

describe("a call on a connection", () => {
  it("runs the action and returns its output and the resources it read", async () => {
    const connectionId = await addConnection();
    const result = await callAs(
      anna,
      write(connectionId, "mail.list", { top: 10 })
    );
    expect(JSON.parse(result.output)).toStrictEqual({ messages });
    expect(result.provenance).toStrictEqual(messages);
    expect(server.ran).toStrictEqual([
      { tool: "mail.list", input: { top: 10 } },
    ]);
  });

  it("is refused on a connection that doesn't exist", async () => {
    await expect(
      outcome(callAs(anna, write("connection-missing")))
    ).resolves.toBe("connect.connection_not_found");
    expect(server.requests).toBe(0);
  });

  it("is refused on a connection that isn't active, without reaching it", async () => {
    const statuses = ["needs_reauth", "disconnected"] as const;
    const refused = await Promise.all(
      statuses.map(async (status) => {
        const connectionId = await addConnection({ status });
        return await outcome(callAs(anna, write(connectionId)));
      })
    );
    expect(refused).toStrictEqual(
      statuses.map(() => "connect.connection_inactive")
    );
    expect(server.requests).toBe(0);
  });

  it("reaches someone's personal connection only when it acts for them", async () => {
    const connectionId = await addConnection({
      scope: "personal",
      ownerUserId: "user-anna",
    });
    const call = write(connectionId);
    await expect(outcome(callAs(anna, call))).resolves.toBe("ok");
    // Ben's agent, even with a capability for exactly this call (core signs
    // one for any member whose agent holds a permission for it).
    await expect(outcome(callAs(ben, call))).resolves.toBe("connect.not_owner");
    // Another agent acting for Anna is Anna's own context.
    await expect(
      outcome(callAs(agentFor("user-anna", "agent-other"), call))
    ).resolves.toBe("ok");
    expect(server.ran).toHaveLength(2);
  });

  it("doesn't tell someone else whether a personal connection is active", async () => {
    const connectionId = await addConnection({
      scope: "personal",
      ownerUserId: "user-anna",
      status: "disconnected",
    });
    await expect(outcome(callAs(ben, write(connectionId)))).resolves.toBe(
      "connect.not_owner"
    );
  });

  it("reaches any member's shared connection", async () => {
    const connectionId = await addConnection({ scope: "shared" });
    await expect(outcome(callAs(anna, write(connectionId)))).resolves.toBe(
      "ok"
    );
    await expect(outcome(callAs(ben, write(connectionId)))).resolves.toBe("ok");
  });

  it("runs only an action named exactly as the server names it", async () => {
    const connectionId = await addConnection();
    const others = ["MAIL.LIST", "Mail.List", "mail.lis", "mail.list.all"];
    const refused = await Promise.all(
      others.map(
        async (action) =>
          await outcome(callAs(anna, write(connectionId, action)))
      )
    );
    expect(refused).toStrictEqual(others.map(() => "connect.action_not_found"));
    expect(server.ran).toStrictEqual([]);
  });

  it("is refused when the call names another action than its capability", async () => {
    const connectionId = await addConnection();
    const call = write(connectionId);
    const capability = await capabilityFor(anna, call);
    await expect(
      outcome(
        exports.default.call({ ...call, action: "MAIL.LIST", capability })
      )
    ).resolves.toBe("capability.invalid");
  });

  it("treats every tool of a Composio server as a side effect, whatever it declares", async () => {
    const connectionId = await addConnection();
    const { idempotencyKey: _key, ...withoutKey } = write(connectionId);
    await expect(outcome(callAs(anna, withoutKey))).resolves.toBe(
      "connect.idempotency_key_required"
    );
    expect(server.ran).toStrictEqual([]);
  });

  it("holds no Composio call to one resource, whatever the server declares", async () => {
    const connectionId = await addConnection();
    const resource = "anna@acme.test";
    await expect(
      outcome(
        callAs(anna, {
          ...write(connectionId, "mail.read", { mailbox: resource }),
          resource,
        })
      )
    ).resolves.toBe("connect.resource_out_of_scope");
    expect(server.ran).toStrictEqual([]);
  });

  it("holds every call of a restricted context on a Composio server, whatever the server declares", async () => {
    const connectionId = await addConnection();
    // `mail.list` says it is read-only, but only a native connector's word
    // counts: on Composio every tool may act, so the person decides.
    await expect(
      outcome(
        callAs(anna, write(connectionId), {
          restricted: true,
          origin: chatOrigin,
        })
      )
    ).resolves.toBe("connect.held");
    expect(server.ran).toStrictEqual([]);
  });

  it("refuses a side effect from chat until the person can confirm it", async () => {
    const connectionId = await addConnection();
    const inChat = agentFor("user-anna", "agent-chat", "interactive");
    await expect(outcome(callAs(inChat, write(connectionId)))).resolves.toBe(
      "connect.confirmation_required"
    );
    expect(server.ran).toStrictEqual([]);
  });

  it("returns content other than text as the content blocks themselves", async () => {
    const connectionId = await addConnection();
    const result = await callAs(anna, write(connectionId, "mail.photo"));
    expect(JSON.parse(result.output)).toStrictEqual([
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
  });

  it("reports the tool's own error with its output", async () => {
    const connectionId = await addConnection();
    const failed = await callAs(
      anna,
      write(connectionId, "mail.search", { query: "" })
    ).catch((error: unknown) => error);
    expect(connectErrors.codeOf(failed)).toBe("connect.action_failed");
    expect(failed).toHaveProperty("details", {
      output: JSON.stringify({ error: "An empty query" }),
    });
  });

  it("is refused when its input isn't an object of arguments, or is too large", async () => {
    const connectionId = await addConnection();
    const inputs = [[], "query", 1, null];
    const refused = await Promise.all(
      inputs.map(
        async (input) =>
          await outcome(callAs(anna, write(connectionId, "mail.list", input)))
      )
    );
    expect(refused).toStrictEqual(inputs.map(() => "connect.invalid"));
    await expect(
      outcome(
        callAs(
          anna,
          write(connectionId, "mail.list", { text: "x".repeat(70 * 1024) })
        )
      )
    ).resolves.toBe("connect.input_too_large");
    expect(server.requests).toBe(0);
  });

  it("goes nowhere on a native connection while native connectors aren't loaded", async () => {
    const connectionId = await addConnection({
      serverKind: "native",
      server: "microsoft-365",
    });
    await expect(outcome(callAs(anna, write(connectionId)))).resolves.toBe(
      "connect.server_unavailable"
    );
    expect(server.requests).toBe(0);
  });

  it("goes nowhere but Composio's MCP host, over HTTPS, without credentials", async () => {
    const withCredentials = new URL(serverUrl);
    withCredentials.username = "user";
    withCredentials.password = "not-a-real-password";
    const servers = [
      serverUrl.replace("https:", "http:"),
      withCredentials.href,
      "https://mcp.attacker.example/v3/mcp/server-mail",
      "https://backend.composio.dev.attacker.example/v3/mcp/server-mail",
      "https://backend.composio.dev/api/v3/connected_accounts",
      "https://127.0.0.1/v3/mcp/server-mail",
    ];
    const ends = await Promise.all(
      servers.map(async (url) => {
        const connectionId = await addConnection({ server: url });
        return await outcome(callAs(anna, write(connectionId)));
      })
    );
    expect(ends).toStrictEqual(servers.map(() => "connect.server_unavailable"));
    expect(server.requests).toBe(0);
  });
});

describe("a call to a server that answers in event streams", () => {
  const streaming = fakeMcpServer(serverUrl, tools, {
    stream: true,
    padding: 20_000,
  });

  it("runs the action, reading many tiny events in linear time", async () => {
    const connectionId = await addConnection();
    const started = Date.now();
    const result = await callAs(anna, write(connectionId));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.provenance).toStrictEqual(messages);
    expect(streaming.ran).toHaveLength(1);
  });
});
