import { connectErrors } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import { describe, expect, it } from "vite-plus/test";

import type { McpServerTool, McpTool } from "../src/mcp.ts";
import {
  checkResourceScope,
  composioTool,
  hasSideEffect,
} from "../src/policy.ts";

// What connect takes a tool to be, as pure logic: a native connector's
// tool as its manifest declares it, a Composio server's as the admin's
// rule for it says, whatever the server declares.

const readMailbox: McpTool = {
  name: "mail.read",
  readOnly: true,
  resourceField: "mailbox",
  inputProperties: ["mailbox", "query", "sharedMailbox"],
};

const resource = "anna@acme.test";

/** The code a scope check refuses with, or "ok". */
const scope = (
  input: Record<string, Json>,
  tool: McpTool = readMailbox
): string => {
  try {
    checkResourceScope(resource, tool, input);
    return "ok";
  } catch (error) {
    return connectErrors.codeOf(error) ?? String(error);
  }
};

/** A Composio server's tool, as connect reads it: no hints at all. */
const serverTool: McpServerTool = {
  name: "mail.read",
  inputProperties: ["mailbox", "query", "sharedMailbox"],
};

describe("a tool", () => {
  it("is a read only when declared read-only", () => {
    const write = { ...readMailbox, readOnly: false };
    expect([
      hasSideEffect(readMailbox, "native", false),
      hasSideEffect(write, "native", false),
    ]).toStrictEqual([false, true]);
  });

  it("on a Composio server is what the admin's rule says", () => {
    const byName = composioTool(serverTool, {
      read: false,
      resource: undefined,
    });
    const asRead = composioTool(serverTool, {
      read: true,
      resource: "sharedMailbox",
    });
    expect([
      hasSideEffect(byName, "composio", false),
      byName.resourceField,
      hasSideEffect(asRead, "composio", false),
      asRead.resourceField,
    ]).toStrictEqual([true, undefined, false, "sharedMailbox"]);
  });

  it("on a Composio server is a side effect from a restricted context, even a read", () => {
    const asRead = composioTool(serverTool, {
      read: true,
      resource: undefined,
    });
    expect([
      hasSideEffect(asRead, "composio", true),
      // A native read stays a read: its data stays with the connection.
      hasSideEffect(readMailbox, "native", true),
    ]).toStrictEqual([true, false]);
  });
});

describe("a call for one resource", () => {
  it("goes through when the declared property names exactly that resource", () => {
    expect([
      scope({ mailbox: resource }),
      scope({ mailbox: resource, query: "invoices" }),
    ]).toStrictEqual(["ok", "ok"]);
  });

  it("is refused when the input reaches for another resource", () => {
    const escapes = [
      scope({ mailbox: "ceo@acme.test" }),
      scope({ mailbox: "Anna@acme.test" }),
      scope({}),
      // Another spelling of the property, or a second property naming a
      // resource that the tool's schema doesn't declare.
      scope({ mailbox: resource, Mailbox: "ceo@acme.test" }),
      scope({ mailbox: resource, mailbox_: "ceo@acme.test" }),
      scope({ mailbox: resource, owner: "ceo@acme.test" }),
    ];
    expect(escapes).toStrictEqual(
      escapes.map(() => "connect.resource_out_of_scope")
    );
  });

  it("is refused when the tool doesn't say plainly where its resource is", () => {
    const tools: McpTool[] = [
      { ...readMailbox, resourceField: undefined },
      { ...readMailbox, resourceField: "mailbox.address" },
      { ...readMailbox, resourceField: "mailbox[0]" },
      { ...readMailbox, resourceField: "folder" },
      { ...readMailbox, inputProperties: undefined },
    ];
    const refused = tools.map((tool) =>
      scope({ mailbox: resource, "mailbox.address": resource }, tool)
    );
    expect(refused).toStrictEqual(
      tools.map(() => "connect.resource_out_of_scope")
    );
  });

  it("is refused on a Composio tool whose rule names no resource", () => {
    const tool = composioTool(serverTool, { read: true, resource: undefined });
    expect(scope({ mailbox: resource }, tool)).toBe(
      "connect.resource_out_of_scope"
    );
  });

  it("goes through on a Composio tool held by the property its rule names", () => {
    const tool = composioTool(serverTool, { read: true, resource: "mailbox" });
    expect([
      scope({ mailbox: resource }, tool),
      scope({ mailbox: "ceo@acme.test" }, tool),
    ]).toStrictEqual(["ok", "connect.resource_out_of_scope"]);
  });

  it("isn't restricted when the capability covers the whole connection", () => {
    expect(() => {
      checkResourceScope(null, readMailbox, { mailbox: "ceo@acme.test" });
    }).not.toThrow();
  });
});
