import { connectErrors } from "@grasp-os/shared/connect";
import type { Json } from "@grasp-os/shared/json";
import { describe, expect, it } from "vite-plus/test";

import type { McpTool } from "../src/mcp.ts";
import { checkResourceScope, hasSideEffect } from "../src/policy.ts";

// What connect takes from a server's description of its tools, as pure
// logic: native connectors can't be loaded yet, so no call reaches one.

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
  tool: McpTool = readMailbox,
  kind: "native" | "composio" = "native"
): string => {
  try {
    checkResourceScope(resource, kind, tool, input);
    return "ok";
  } catch (error) {
    return connectErrors.codeOf(error) ?? String(error);
  }
};

describe("a tool", () => {
  it("is a read only on a native server that declares it read-only", () => {
    const write = { ...readMailbox, readOnly: false };
    expect([
      hasSideEffect("native", readMailbox),
      hasSideEffect("native", write),
      hasSideEffect("composio", readMailbox),
    ]).toStrictEqual([false, true, true]);
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

  it("is refused on a server that isn't ours", () => {
    expect(scope({ mailbox: resource }, readMailbox, "composio")).toBe(
      "connect.resource_out_of_scope"
    );
  });

  it("isn't restricted when the capability covers the whole connection", () => {
    expect(() => {
      checkResourceScope(null, "composio", readMailbox, {
        mailbox: "ceo@acme.test",
      });
    }).not.toThrow();
  });
});
