import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { defineConnector, defineTool, ToolError } from "../src/connector.ts";
import {
  connectorManifestSchema,
  pathMatches,
  queryMatches,
  redirectHostMatches,
} from "../src/manifest.ts";
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

/** A manifest with one action searching through `query`, of `input`. */
const searchingManifest = (input: string[]) =>
  connectorManifestSchema.parse({
    name: "example",
    version: "1.0.0",
    provider: "microsoft",
    scopes: [],
    hosts: ["api.example.test"],
    actions: {
      "items.list": {
        routes: [],
        readOnly: true,
        resource: null,
        input,
        searches: { query: ["body"] },
      },
    },
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
      // Anything at all, where a second selector could hide.
      z.strictObject({ mailbox: z.string(), opts: z.unknown() }),
      z.strictObject({ mailbox: z.string(), opts: z.any() }),
      z.strictObject({ mailbox: z.string(), opts: z.array(z.any()) }),
      z.strictObject({
        mailbox: z.string(),
        opts: z.tuple([z.string()]).rest(z.any()),
      }),
      z.strictObject({
        mailbox: z.string(),
        opts: z.union([z.string(), z.unknown()]),
      }),
    ];
    for (const input of loose) {
      expect(() => toolWith(input)).toThrow("strict");
    }
  });

  it("takes closed tuples, literals, enums and nullable values", () => {
    expect(() =>
      toolWith(
        z.strictObject({
          pair: z.tuple([z.string(), z.number()]),
          kind: z.enum(["a", "b"]),
          one: z.literal(1),
          maybe: z.string().nullable(),
        })
      )
    ).not.toThrow();
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

  it("masks only nullable fields its output has, and names its searches", () => {
    const withMask = (mask: string[]) =>
      defineTool({
        name: "items.list",
        description: "Lists items",
        input: z.strictObject({ search: z.string().optional() }),
        output: z.strictObject({
          items: z.array(
            z.strictObject({ subject: z.string().nullable(), id: z.string() })
          ),
        }),
        readOnly: true,
        mask,
        searches: { search: ["subject"] },
        routes: [route],
        run: async () => await Promise.resolve({ output: { items: [] } }),
      });
    expect(withMask(["items.subject"]).action).toMatchObject({
      mask: ["items.subject"],
      searches: { search: ["subject"] },
    });
    for (const path of ["items.body", "subject", "items.subject.x"]) {
      expect(() => withMask([path])).toThrow("to mask");
    }
    // Masked, a field becomes null: one that can't be isn't maskable.
    expect(() => withMask(["items.id"])).toThrow("must be nullable");
  });

  it("reports an error with a code callers can act on, when it has one", async () => {
    const failing = (error: Error) =>
      defineTool({
        name: "items.list",
        description: "Lists items",
        input: z.strictObject({}),
        output: z.strictObject({}),
        readOnly: true,
        routes: [route],
        run: () => {
          throw error;
        },
      });
    await expect(
      failing(
        new ToolError("Throttled", { code: "throttled", retryAfterSeconds: 7 })
      ).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "Throttled" }],
      structuredContent: {
        error: {
          message: "Throttled",
          code: "throttled",
          retryAfterSeconds: 7,
        },
      },
      isError: true,
    });
    await expect(
      failing(new ToolError("No such item")).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "No such item" }],
      isError: true,
    });
    // Any other error says nothing of itself.
    await expect(
      failing(new Error("token=abc")).call({})
    ).resolves.toStrictEqual({
      content: [{ type: "text", text: "The action failed" }],
      isError: true,
    });
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

  it("declares no batch endpoint", () => {
    for (const path of [
      "/v1.0/$batch",
      "/batch/gmail/v1",
      "/v1/$BATCH",
      "/v1/Batch",
      "/v1/$batch{id}",
      "/v1/batch{id}",
    ]) {
      expect(() =>
        connectorWith({
          tools: [
            defineTool({
              name: "items.list",
              description: "Lists items",
              input: z.strictObject({}),
              output: z.strictObject({}),
              readOnly: true,
              routes: [{ ...route, path }],
              run: async () => await Promise.resolve({ output: {} }),
            }),
          ],
        })
      ).toThrow("Not a path template");
    }
  });

  it("binds every route of a resource-scoped tool to its resource", () => {
    const withRoutes = (paths: (string | Partial<Route>)[]) =>
      connectorWith({
        tools: [
          defineTool({
            name: "items.list",
            description: "Lists items",
            input: z.strictObject({ mailbox: z.string() }),
            output: z.strictObject({}),
            readOnly: true,
            resource: "mailbox",
            routes: paths.map((path) =>
              typeof path === "string"
                ? { ...route, path }
                : { ...route, ...path }
            ),
            run: async () => await Promise.resolve({ output: {} }),
          }),
        ],
      });
    expect(() =>
      withRoutes(["/v1/users/{mailbox}/messages", "/v1/users/{mailbox}:peek"])
    ).not.toThrow();
    for (const paths of [
      ["/v1/users/{user}/messages"],
      ["/v1/users/{mailbox}/messages", "/v1/me/messages"],
    ]) {
      expect(() => withRoutes(paths)).toThrow("must name it");
    }
    // In the query, where the provider takes it there; or, for a GET
    // where it has no place at all, declared unbound.
    expect(() =>
      withRoutes([
        { query: { box: "{mailbox}", corpora: "drive" } },
        { path: "/v1/items/{item}", unbound: true },
      ])
    ).not.toThrow();
    for (const unnamed of [
      { query: { box: "{user}" } },
      { query: { box: "mailbox" } },
      { query: { box: "x{mailbox}" } },
    ]) {
      expect(() => withRoutes([unnamed])).toThrow(/must name it|Not a query/u);
    }
    expect(() =>
      withRoutes([{ method: "POST", path: "/v1/items/{item}", unbound: true }])
    ).toThrow("Only a GET may be unbound");
  });

  it("follows a redirect only from a GET, to hosts one label under a named one", () => {
    const withRoute = (extra: Partial<Route>) =>
      connectorWith({
        tools: [
          defineTool({
            name: "items.read",
            description: "Reads an item",
            input: z.strictObject({}),
            output: z.strictObject({}),
            readOnly: true,
            routes: [{ ...route, ...extra }],
            run: async () => await Promise.resolve({ output: {} }),
          }),
        ],
      });
    expect(() => withRoute({ redirects: ["*.sharepoint.com"] })).not.toThrow();
    expect(() =>
      withRoute({ method: "POST", redirects: ["*.sharepoint.com"] })
    ).toThrow("Only a GET");
    for (const pattern of [
      "sharepoint.com",
      "*.com",
      "*.*.sharepoint.com",
      "*.SharePoint.com",
      "*sharepoint.com",
      "*.sharepoint.com:443",
    ]) {
      expect(() => withRoute({ redirects: [pattern] })).toThrow(
        "Not a redirect host"
      );
    }
  });

  it("searches only through inputs it has", () => {
    expect(() => searchingManifest(["query"])).not.toThrow();
    expect(() => searchingManifest([])).toThrow(
      "searches must be among its input properties"
    );
  });

  it("has one tool per name", () => {
    const tool = toolWith(z.strictObject({}));
    expect(() => connectorWith({ tools: [tool, tool] })).toThrow("Two tools");
  });
});

describe("a redirect host", () => {
  it("stands for exactly one DNS label under its host", () => {
    for (const host of [
      "example.sharepoint.com",
      "example-my.sharepoint.com",
    ]) {
      expect(redirectHostMatches("*.sharepoint.com", host)).toBeTruthy();
    }
    for (const host of [
      "sharepoint.com",
      ".sharepoint.com",
      "evilsharepoint.com",
      "a.b.sharepoint.com",
      "example.sharepoint.com.evil.test",
      "-example.sharepoint.com",
    ]) {
      expect(redirectHostMatches("*.sharepoint.com", host)).toBeFalsy();
    }
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

  it("takes no parameter that decodes to more than plain text", () => {
    for (const segment of [
      "..",
      "%2e%2e",
      "a%2Fb",
      "a%5Cb",
      "%",
      ".",
      "%252e%252e%252f",
      "a%00b",
      "a%0D%0Ab",
      "a%7Fb",
      "..;",
      "a;x=y",
      "a%3Fb",
      "a%23b",
      "a:b",
      "a%3Ab",
      "batch",
      "%24batch",
      "$BATCH",
    ]) {
      expect(
        pathMatches(template, `/v1/users/${segment}/messages`)
      ).toBeFalsy();
    }
  });

  it("binds a parameter to a value, where it is given one", () => {
    const values = { mailbox: "a@acme.test" };
    expect(
      pathMatches(template, "/v1/users/a%40acme.test/messages", values)
    ).toBeTruthy();
    expect(
      pathMatches(template, "/v1/users/b%40acme.test/messages", values)
    ).toBeFalsy();
  });

  it("takes a parameter inside literal text only as declared", () => {
    const search = "/v1/drives/{drive}/root/search(q='{query}')";
    // Inside literal text, a value is neither a dot segment nor a batch
    // endpoint, so those words may be searched for.
    for (const query of ["invoice", "invoice%202026", "it''s", "batch", ".."]) {
      expect(
        pathMatches(search, `/v1/drives/d-1/root/search(q='${query}')`)
      ).toBeTruthy();
    }
    for (const segment of [
      "search(q='')",
      "search(q='a%2Fb')",
      "search(q='a:b')",
      "search(q='a%25')",
      // A quote only comes doubled, as OData escapes it.
      "search(q='a'')",
      "search(q='a'%20or%20'b')",
      "search(q='%27')",
      "search(q=a)",
      "search(q='a')x",
      "find(q='a')",
      "search(q=')",
    ]) {
      expect(pathMatches(search, `/v1/drives/d-1/root/${segment}`)).toBeFalsy();
    }
  });

  it("takes a literal suffix only as declared", () => {
    const custom = "/v1/files/{id}:batchUpdate";
    expect(pathMatches(custom, "/v1/files/f-1:batchUpdate")).toBeTruthy();
    for (const path of [
      "/v1/files/f-1",
      "/v1/files/f-1:delete",
      "/v1/files/f-1%3AbatchUpdate",
      "/v1/files/:batchUpdate",
      "/v1/files/a:b:batchUpdate",
    ]) {
      expect(pathMatches(custom, path)).toBeFalsy();
    }
  });
});

const params = (search: string) => new URLSearchParams(search);

describe("a route's query", () => {
  const query = { corpora: "drive", driveId: "{drive}" };

  it("holds each parameter it names exactly once, as declared", () => {
    expect(
      queryMatches(query, params("corpora=drive&driveId=d-1&q=x"))
    ).toBeTruthy();
    expect(queryMatches(undefined, params("anything=1"))).toBeTruthy();
    for (const search of [
      "driveId=d-1",
      "corpora=user&driveId=d-1",
      "corpora=drive",
      "corpora=drive&driveId=",
      "corpora=drive&driveId=d-1&driveId=d-2",
      "corpora=drive&corpora=user&driveId=d-1",
      "corpora=drive&driveId=d%0A1",
      "corpora=drive&driveId=d-1&drive_id=d-2",
      "corpora=drive&driveId=d-1&DriveID=d-2",
      "Corpora=drive&driveId=d-1",
    ]) {
      expect(queryMatches(query, params(search))).toBeFalsy();
    }
  });

  it("binds a parameter to a value, where it is given one", () => {
    const values = { drive: "d-1" };
    expect(
      queryMatches(query, params("corpora=drive&driveId=d-1"), values)
    ).toBeTruthy();
    for (const search of [
      "corpora=drive&driveId=d-2",
      "corpora=drive&driveId=D-1",
      "corpora=drive&driveId=d-1%20",
    ]) {
      expect(queryMatches(query, params(search), values)).toBeFalsy();
    }
  });
});
