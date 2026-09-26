import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { defineConnector, defineTool } from "../src/connector.ts";
import { pathMatches } from "../src/manifest.ts";
import type { Route } from "../src/manifest.ts";

// The connector contract, as a connector is defined: input parsed strictly
// all the way down, one declared resource property, and only requests to
// the connector's own hosts. A connector that breaks it doesn't build.

const route: Route = {
  method: "GET",
  host: "api.example.test",
  path: "/v1/items",
};

const toolWith = (input: z.ZodObject, resource?: string) =>
  defineTool({
    name: "items.list",
    description: "Lists items",
    input,
    output: z.strictObject({}),
    readOnly: true,
    resource,
    routes: [route],
    run: async () => await Promise.resolve({ output: {} }),
  });

const connectorWith = (
  fields: Partial<Parameters<typeof defineConnector>[0]>
) =>
  defineConnector({
    name: "example",
    version: "1.0.0",
    provider: "microsoft",
    scopes: [],
    hosts: ["api.example.test"],
    tools: [],
    ...fields,
  });

describe("a tool", () => {
  it("takes strict input with a string resource property", () => {
    expect(() =>
      toolWith(
        z.strictObject({
          mailbox: z.string(),
          filter: z.strictObject({ from: z.string() }).optional(),
          ids: z.array(z.strictObject({ id: z.string() })).optional(),
        }),
        "mailbox"
      )
    ).not.toThrow();
  });

  it("can't take input that drops or passes through unknown keys, at any depth", () => {
    const loose = [
      z.object({ mailbox: z.string() }),
      z.looseObject({ mailbox: z.string() }),
      z.strictObject({
        mailbox: z.string(),
        options: z.object({ a: z.string() }),
      }),
      z.strictObject({
        mailbox: z.string(),
        extra: z.record(z.string(), z.string()),
      }),
      z.strictObject({
        mailbox: z.string(),
        items: z.array(z.looseObject({ id: z.string() })),
      }),
      z.strictObject({
        mailbox: z.string(),
        target: z.union([z.string(), z.object({ mailbox: z.string() })]),
      }),
      z.strictObject({ mailbox: z.string() }).catchall(z.string()),
    ];
    for (const input of loose) {
      expect(() => toolWith(input)).toThrow("strict");
    }
  });

  it("names as its resource only one of its own string properties", () => {
    const input = z.strictObject({
      mailbox: z.string(),
      top: z.number(),
      target: z.strictObject({ mailbox: z.string() }),
    });
    for (const resource of [
      "top",
      "target",
      "target.mailbox",
      "sharedMailbox",
    ]) {
      expect(() => toolWith(input, resource)).toThrow("resource");
    }
  });
});

describe("a connector", () => {
  it("sends requests only to its own hosts", () => {
    expect(() =>
      connectorWith({
        tools: [
          defineTool({
            name: "items.list",
            description: "Lists items",
            input: z.strictObject({}),
            output: z.strictObject({}),
            readOnly: true,
            routes: [{ ...route, host: "evil.test" }],
            run: async () => await Promise.resolve({ output: {} }),
          }),
        ],
      })
    ).toThrow("Every route's host must be one of the connector's hosts");
  });

  it("lists only exact DNS names as hosts", () => {
    for (const host of [
      "API.example.test",
      "api.example.test:443",
      "127.0.0.1",
      "localhost",
      "*.example.test",
      "user@api.example.test",
    ]) {
      expect(() => connectorWith({ hosts: [host] })).toThrow("pattern");
    }
  });

  it("has one tool per name", () => {
    const tool = toolWith(z.strictObject({}));
    expect(() => connectorWith({ tools: [tool, tool] })).toThrow("Two tools");
  });
});

describe("a route's path", () => {
  const template = "/v1/users/{mailbox}/messages";

  it("matches only its own segments, with one segment for each parameter", () => {
    expect(
      pathMatches(template, "/v1/users/a%40acme.test/messages")
    ).toBeTruthy();
    for (const path of [
      "/v1/users/messages",
      "/v1/users/a/b/messages",
      "/v1/users//messages",
      "/v1/users/a/messages/",
      "/v1/Users/a/messages",
      "/v1/users/a/messages/x",
    ]) {
      expect(pathMatches(template, path)).toBeFalsy();
    }
  });

  it("takes no parameter that decodes to a path of its own", () => {
    for (const segment of ["..", "%2e%2e", "a%2Fb", "a%5Cb", "%", "."]) {
      expect(
        pathMatches(template, `/v1/users/${segment}/messages`)
      ).toBeFalsy();
    }
  });
});
