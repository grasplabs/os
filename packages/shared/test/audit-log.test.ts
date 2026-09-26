import { describe, expect, it } from "vite-plus/test";

import { auditEventTypeOf } from "../src/audit-log.ts";

const typeOf = (action: string, detail = {}) =>
  auditEventTypeOf({ action, detail });

describe("audit event types", () => {
  it("files the log's own events by what they do", () => {
    expect(
      ["audit.searched", "audit.exported", "audit.verified"].map((action) =>
        typeOf(action)
      )
    ).toStrictEqual(["read", "read", "read"]);
    expect(typeOf("audit.archived")).toBe("action");
    expect(typeOf("audit.purged")).toBe("action");
  });

  it("gives an audit action no rule names no type, rather than filing it as a read", () => {
    expect(typeOf("audit.something_new")).toBeNull();
  });

  it("files a connector call by whether it changed something", () => {
    expect(typeOf("connection.call", { sideEffect: true })).toBe("action");
    expect(typeOf("connection.call", { sideEffect: false })).toBe("read");
    expect(typeOf("connection.call.provenance")).toBe("read");
  });
});
