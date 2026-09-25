import { connectErrors } from "@grasp-os/shared/connect";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addConnection,
  agentFor,
  callAs,
  capabilityFor,
  outcome,
  serverUrl,
} from "./connect.ts";
import { fakeMcpServer } from "./mcp-server.ts";
import type { FakeTool } from "./mcp-server.ts";

// Which connection a call may reach and what it may do there: only a
// connection that is active, a personal one only for its owner, only the
// exact action the capability names, and within one resource the
// capability's resource, whatever the input says.

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
    run: ({ mailbox }) => ({
      output: { mailbox, messages },
      provenance: messages,
    }),
  },
  {
    name: "mail.search",
    readOnly: true,
    run: ({ query }) =>
      query === ""
        ? { output: { error: "An empty query" }, isError: true }
        : { output: { messages: [] } },
  },
];

const server = fakeMcpServer(serverUrl, tools);

const anna = agentFor("user-anna");
const ben = agentFor("user-ben");

describe("a call on a connection", () => {
  it("runs the action and returns its output and the resources it read", async () => {
    const connectionId = await addConnection();
    const result = await callAs(anna, {
      connectionId,
      action: "mail.list",
      input: { top: 10 },
    });
    expect(JSON.parse(result.output)).toStrictEqual({ messages });
    expect(result.provenance).toStrictEqual(messages);
    expect(server.ran).toStrictEqual([
      { tool: "mail.list", input: { top: 10 } },
    ]);
  });

  it("is refused on a connection that doesn't exist", async () => {
    await expect(
      outcome(
        callAs(anna, {
          connectionId: "connection-missing",
          action: "mail.list",
          input: {},
        })
      )
    ).resolves.toBe("connect.connection_not_found");
    expect(server.requests).toBe(0);
  });

  it("is refused on a connection that isn't active, without reaching it", async () => {
    const statuses = ["needs_reauth", "disconnected"] as const;
    const refused = await Promise.all(
      statuses.map(async (status) => {
        const connectionId = await addConnection({ status });
        return await outcome(
          callAs(anna, { connectionId, action: "mail.list", input: {} })
        );
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
    const call = { connectionId, action: "mail.list", input: {} };
    await expect(outcome(callAs(anna, call))).resolves.toBe("ok");
    // Ben's agent, even with a capability for exactly this call (core signs
    // one for any member whose agent holds a permission for it).
    await expect(outcome(callAs(ben, call))).resolves.toBe("connect.not_owner");
    // Another agent or App acting for Anna is Anna's own context.
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
    await expect(
      outcome(callAs(ben, { connectionId, action: "mail.list", input: {} }))
    ).resolves.toBe("connect.not_owner");
  });

  it("reaches any member's shared connection", async () => {
    const connectionId = await addConnection({ scope: "shared" });
    const call = { connectionId, action: "mail.list", input: {} };
    await expect(outcome(callAs(anna, call))).resolves.toBe("ok");
    await expect(outcome(callAs(ben, call))).resolves.toBe("ok");
  });

  it("runs only an action named exactly as the server names it", async () => {
    const connectionId = await addConnection();
    const others = ["MAIL.LIST", "Mail.List", "mail.lis", "mail.list.all"];
    const refused = await Promise.all(
      others.map(
        async (action) =>
          await outcome(callAs(anna, { connectionId, action, input: {} }))
      )
    );
    expect(refused).toStrictEqual(others.map(() => "connect.action_not_found"));
    expect(server.ran).toStrictEqual([]);
  });

  it("is refused when the call names another action than its capability", async () => {
    const connectionId = await addConnection();
    const capability = await capabilityFor(anna, {
      connectionId,
      action: "mail.list",
      input: {},
    });
    await expect(
      outcome(
        exports.default.call({
          connectionId,
          action: "MAIL.LIST",
          input: {},
          capability,
        })
      )
    ).resolves.toBe("capability.invalid");
  });

  it("stays on the one resource its capability is for", async () => {
    const connectionId = await addConnection();
    const resource = "anna@acme.test";
    const reach = async (
      input: Record<string, string>,
      action = "mail.read"
    ): Promise<string> =>
      await outcome(callAs(anna, { connectionId, resource, action, input }));

    await expect(reach({ mailbox: resource })).resolves.toBe("ok");
    const escapes = await Promise.all([
      // Another mailbox, the same one spelt differently, or none at all.
      reach({ mailbox: "ceo@acme.test" }),
      reach({ mailbox: "Anna@acme.test" }),
      reach({}),
      reach({ mailboxes: resource }),
      // An action that doesn't say which resource it touches.
      reach({ mailbox: resource }, "mail.list"),
    ]);
    expect(escapes).toStrictEqual(
      escapes.map(() => "connect.resource_out_of_scope")
    );
    expect(server.ran).toStrictEqual([
      { tool: "mail.read", input: { mailbox: resource } },
    ]);
  });

  it("reaches every resource with a capability for the whole connection", async () => {
    const connectionId = await addConnection();
    await expect(
      outcome(
        callAs(anna, {
          connectionId,
          action: "mail.read",
          input: { mailbox: "ceo@acme.test" },
        })
      )
    ).resolves.toBe("ok");
  });

  it("reports the tool's own error with its output", async () => {
    const connectionId = await addConnection();
    const failed = await callAs(anna, {
      connectionId,
      action: "mail.search",
      input: { query: "" },
    }).catch((error: unknown) => error);
    expect(connectErrors.codeOf(failed)).toBe("connect.action_failed");
    expect(failed).toHaveProperty("details", {
      output: JSON.stringify({ error: "An empty query" }),
    });
  });

  it("is refused when its input isn't an object of arguments", async () => {
    const connectionId = await addConnection();
    const inputs = [[], "query", 1, null];
    const refused = await Promise.all(
      inputs.map(
        async (input) =>
          await outcome(
            callAs(anna, { connectionId, action: "mail.list", input })
          )
      )
    );
    expect(refused).toStrictEqual(inputs.map(() => "connect.invalid_call"));
    expect(server.requests).toBe(0);
  });

  it("goes nowhere on a native connection while native connectors aren't loaded", async () => {
    const connectionId = await addConnection({
      serverKind: "native",
      server: "microsoft-365",
    });
    await expect(
      outcome(callAs(anna, { connectionId, action: "mail.list", input: {} }))
    ).resolves.toBe("connect.server_unavailable");
    expect(server.requests).toBe(0);
  });

  it("goes nowhere when a connection's server isn't a plain HTTPS URL", async () => {
    const withCredentials = new URL(serverUrl);
    withCredentials.username = "user";
    withCredentials.password = "not-a-real-password";
    const servers = [
      serverUrl.replace("https:", "http:"),
      withCredentials.href,
    ];
    const ends = await Promise.all(
      servers.map(async (url) => {
        const connectionId = await addConnection({ server: url });
        return await outcome(
          callAs(anna, { connectionId, action: "mail.list", input: {} })
        );
      })
    );
    expect(ends).toStrictEqual(servers.map(() => "connect.server_unavailable"));
    expect(server.requests).toBe(0);
  });
});

describe("a call to a server that answers in event streams", () => {
  const streaming = fakeMcpServer(serverUrl, tools, { stream: true });

  it("runs the action as with JSON answers", async () => {
    const connectionId = await addConnection();
    const result = await callAs(anna, {
      connectionId,
      action: "mail.list",
      input: {},
    });
    expect(result.provenance).toStrictEqual(messages);
    expect(streaming.ran).toHaveLength(1);
  });
});
