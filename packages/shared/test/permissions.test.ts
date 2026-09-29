import { describe, expect, it } from "vite-plus/test";

import {
  bindingNameSchema,
  permissionRequestSchema,
} from "../src/permissions.ts";

const request = {
  subject: { type: "app", appId: "app-invoices" },
  object: { type: "connection", connectionId: "connection-outlook" },
  actions: ["mail.list", "GMAIL_SEND_EMAIL"],
  binding: "OUTLOOK",
};

const isValid = (changes: object): boolean =>
  permissionRequestSchema.safeParse({ ...request, ...changes }).success;

describe("permission requests", () => {
  it("are for an App or an agent, never a person or anything else", () => {
    expect(isValid({})).toBeTruthy();
    expect(isValid({ subject: { type: "agent", agentId: "a" } })).toBeTruthy();
    for (const subject of [
      { type: "person", userId: "u" },
      { type: "app", appId: "" },
      { type: "app", appId: "a", agentId: "a" },
      { type: "app", appId: "a".repeat(257) },
    ]) {
      expect(isValid({ subject })).toBeFalsy();
    }
  });

  it("name a binding that can't collide with an object's own members", () => {
    for (const binding of ["OUTLOOK", "FINANCE_MAIL_2"]) {
      expect(isValid({ binding })).toBeTruthy();
    }
    for (const binding of [
      "__proto__",
      "constructor",
      "toString",
      "prototype",
      "outlook",
      "_OUTLOOK",
      "2FA",
      "OUT-LOOK",
      "",
      "A".repeat(65),
    ]) {
      expect(isValid({ binding })).toBeFalsy();
    }
  });

  it("allow only the actions their object has", () => {
    const collection = { type: "collection", collectionId: "c" };
    const workflow = { type: "workflow", appId: "a", workflowId: "w" };
    expect(
      isValid({ object: collection, actions: ["read", "write"] })
    ).toBeTruthy();
    expect(isValid({ object: workflow, actions: ["start"] })).toBeTruthy();
    expect(isValid({ object: collection, actions: ["delete"] })).toBeFalsy();
    expect(isValid({ object: workflow, actions: ["write"] })).toBeFalsy();
  });

  it("allow at least one action, each once, each a name", () => {
    expect(isValid({ actions: [] })).toBeFalsy();
    expect(isValid({ actions: ["mail.list", "mail.list"] })).toBeFalsy();
    expect(isValid({ actions: ["mail list"] })).toBeFalsy();
  });

  it("stay small enough to be audited whole", () => {
    const actions = Array.from({ length: 16 }, (_, index) =>
      `action.${index}`.padEnd(20, "x")
    );
    expect(isValid({ actions })).toBeFalsy();
    expect(isValid({ actions: actions.slice(0, 8) })).toBeTruthy();
  });
});

// Core's and connect's env tests check only the names their test env
// carries. The optional secrets and switches a deployment may leave unset
// are checked here by name, so none can drop off the reserved list unseen.
describe("reserved binding names", () => {
  it.each([
    "ROUTER_SECRET_PREVIOUS",
    "DEV_SKIP_ROUTER_SECRET",
    "CAPABILITY_SIGNING_KEY_PREVIOUS",
    "TOKEN_ENCRYPTION_KEY_PREVIOUS",
    "AUDIT_RETENTION_DAYS",
    "ENTRA_CLIENT_SECRET",
    "GOOGLE_CLIENT_SECRET",
  ])("refuses %s, which only the platform may use", (name) => {
    expect(bindingNameSchema.safeParse(name).success).toBeFalsy();
  });
});
