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

  it("files reading Knowledge as a read, and changing it as an action", () => {
    expect(
      [
        "knowledge.read",
        "knowledge.search",
        "knowledge.search.empty",
        "knowledge.document.saved",
        "knowledge.collection.created",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["read", "read", "read", "action", "config"]);
  });

  it("files computing improvement signals as an action, and reading them as a read", () => {
    expect(
      ["improvement.signals.computed", "improvement.signals.read"].map(
        (action) => typeOf(action)
      )
    ).toStrictEqual(["action", "read"]);
  });

  it("files a workflow's decisions as decisions, and its runs and steps as actions", () => {
    expect(
      [
        "workflow.decision.opened",
        "workflow.decision.approved",
        "workflow.decision.timed_out",
        "workflow.run.started",
        "workflow.run.waiting",
        "workflow.step.completed",
      ].map((action) => typeOf(action))
    ).toStrictEqual([
      "decision",
      "decision",
      "decision",
      "action",
      "action",
      "action",
    ]);
  });

  it("files a person deciding on a held action as a decision, and dropping one as an action", () => {
    expect(
      [
        "connection.action.confirmed",
        "connection.action.declined",
        "connection.action.confirm_refused",
        "connection.action.dropped",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["decision", "decision", "decision", "action"]);
  });

  it("files changes to what's offered, connected and configured as config", () => {
    expect(
      [
        "connection.offer_changed",
        "connection.needs_reauth",
        "workflow.param.updated",
        "model.budget.alert",
        "model.budget.exhausted",
      ].map((action) => typeOf(action))
    ).toStrictEqual(["config", "config", "config", "config", "config"]);
  });

  it("files a model call as one, and a budget crossing as config, not a call", () => {
    expect(typeOf("model.call")).toBe("model_call");
    expect(typeOf("model.refused")).toBe("model_call");
    expect(typeOf("model.budget.alert")).toBe("config");
  });

  it("files a restricted context and a staff sign-in under permissions", () => {
    expect(typeOf("context.restricted")).toBe("permission");
    expect(typeOf("staff.session.started")).toBe("permission");
    expect(typeOf("permission.granted")).toBe("permission");
  });
});
