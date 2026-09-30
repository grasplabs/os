import { connectErrors } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { catalog } from "../src/catalog.ts";
import { fakeComposioApi, hugeAnswerBytes } from "./composio-api.ts";
import type { FakeToolkit } from "./composio-api.ts";
import { outcome } from "./connect.ts";
import { testComposioKey } from "./provider-config.ts";

// The catalog: the native providers of this release, then Composio's
// toolkits, each marked with who carries out its actions. Composio's are
// listed only while connect has its key, and Composio failing leaves the
// native ones listed.

const toolkits: FakeToolkit[] = [
  {
    slug: "hubspot",
    name: "HubSpot",
    categories: ["CRM", "Marketing"],
    tools: [
      {
        slug: "HUBSPOT_LIST_CONTACTS",
        description: "List contacts",
        inputs: ["limit", "after"],
        tags: ["important", "readOnlyHint"],
      },
      {
        slug: "HUBSPOT_CREATE_CONTACT",
        description: "Create a contact",
        tags: ["createHint"],
      },
      // Tagged with nothing: not taken for a read.
      { slug: "HUBSPOT_DELETE_CONTACT" },
    ],
  },
  {
    slug: "linear",
    name: "Linear",
    tools: [{ slug: "LINEAR_LIST_ISSUES" }],
  },
  // Composio holds no app for it: an admin would need one of their own.
  {
    slug: "acme_erp",
    name: "Acme ERP",
    managed: false,
    tools: [{ slug: "ACME_LIST" }],
  },
  // No tools: connecting it couldn't do anything.
  { slug: "empty_kit", name: "Empty", tools: [] },
  {
    slug: "notion",
    name: "Notion",
    tools: [
      { slug: "NOTION_SEARCH", tags: ["readOnlyHint"] },
      // Tags connect can't read, each beside the read-only tag.
      { slug: "NOTION_NOT_STRINGS", tags: ["readOnlyHint", 7] },
      { slug: "NOTION_TOO_LONG", tags: ["readOnlyHint", "t".repeat(129)] },
      {
        slug: "NOTION_TOO_MANY",
        tags: Array.from({ length: 65 }, () => "readOnlyHint"),
      },
      { slug: "NOTION_NOT_A_LIST", tags: "readOnlyHint" },
    ],
  },
];

const { state: composio } = fakeComposioApi(toolkits, {
  // Items connect can't read, among the rest.
  extra: [
    { slug: "Not A Slug", name: "Broken" },
    { name: "No slug" },
    42,
    // Managed, but saying nothing of its tools.
    {
      slug: "no_count",
      name: "No count",
      composio_managed_auth_schemes: ["OAUTH2"],
    },
  ],
});

describe("the catalog", () => {
  it("lists the native providers, then Composio's toolkits, each marked", async () => {
    const listed = await exports.default.catalog();
    expect(listed.composio).toBe("listed");
    expect(
      listed.entries.map(({ source, id, name }) => [source, id, name])
    ).toStrictEqual([
      ["native", "microsoft", "Microsoft 365"],
      ["native", "google", "Google Workspace"],
      ["composio", "hubspot", "HubSpot"],
      ["composio", "linear", "Linear"],
      ["composio", "notion", "Notion"],
    ]);
    expect(listed.entries.find(({ id }) => id === "hubspot")).toStrictEqual({
      source: "composio",
      id: "hubspot",
      name: "HubSpot",
      // No logo: a browser showing Composio's would tell it who looks.
      categories: ["CRM", "Marketing"],
      toolCount: 3,
    });
  });

  it("reads every page of Composio's list, with connect's key, following no redirect", async () => {
    await exports.default.catalog();
    // Five toolkits and four other items, two to a page.
    expect(composio.requests).toHaveLength(5);
    expect(
      composio.requests.every(
        ({ method, keyed, followsRedirects }) =>
          method === "GET" && keyed && !followsRedirects
      )
    ).toBeTruthy();
  });

  it("leaves out toolkits Composio holds no app for, those without tools, and items it can't read", async () => {
    const { entries } = await exports.default.catalog();
    const ids = entries.map(({ id }) => id);
    expect(ids).toStrictEqual([
      "microsoft",
      "google",
      "hubspot",
      "linear",
      "notion",
    ]);
  });

  it("asks Composio once for people looking at the same time", async () => {
    const [first, second] = await Promise.all([
      exports.default.catalog(),
      exports.default.catalog(),
    ]);
    expect(second).toStrictEqual(first);
    // One read of the list's five pages.
    expect(composio.requests).toHaveLength(5);
  });

  it("says Composio is unavailable when its list goes on past what connect reads, and keeps none of it", async () => {
    composio.endless = true;
    const endless = await exports.default.catalog();
    composio.endless = false;
    const after = await exports.default.catalog();
    expect([endless.composio, after.composio]).toStrictEqual([
      "unavailable",
      "listed",
    ]);
  });

  it("keeps what Composio listed for ten minutes, and asks again after", async () => {
    const first = await exports.default.catalog();
    const asked = composio.requests.length;
    const again = await exports.default.catalog();
    expect(again).toStrictEqual(first);
    expect(composio.requests).toHaveLength(asked);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    await exports.default.catalog();
    expect(composio.requests).toHaveLength(asked * 2);
  });

  it("doesn't keep a failure: the next look asks Composio again", async () => {
    composio.health = "down";
    await expect(exports.default.catalog()).resolves.toMatchObject({
      composio: "unavailable",
    });
    composio.health = "up";
    await expect(exports.default.catalog()).resolves.toMatchObject({
      composio: "listed",
    });
  });

  it("gives each native provider's tool count as its tools list them", async () => {
    const { entries } = await exports.default.catalog();
    const counts = await Promise.all(
      entries
        .filter(({ source }) => source === "native")
        .map(async ({ source, id, toolCount }) => {
          const tools = await exports.default.catalogTools({ source, id });
          return toolCount > 0 && tools.length === toolCount;
        })
    );
    expect(counts).toStrictEqual([true, true]);
  });

  it("lists only the native providers while connect has no Composio key", async () => {
    const results = await Promise.all(
      [undefined, ""].map(
        async (key) => await catalog({ ...env, COMPOSIO_API_KEY: key })
      )
    );
    expect(results.map(({ composio: state }) => state)).toStrictEqual([
      "off",
      "off",
    ]);
    expect(composio.requests).toStrictEqual([]);
  });

  it("still lists the native providers when Composio fails", async () => {
    // `stuck`: even a body that fails to cancel ends as unavailable.
    const failures = ["down", "redirect", "garbled", "stuck"] as const;
    const results = [];
    for (const failure of failures) {
      composio.health = failure;
      // oxlint-disable-next-line no-await-in-loop -- one failure at a time
      results.push(await exports.default.catalog());
    }
    expect(
      results.map(({ composio: state, entries }) => [state, entries.length])
    ).toStrictEqual(failures.map(() => ["unavailable", 2]));
  });

  it("reads no more of an answer than its size cap, however valid it is", async () => {
    composio.health = "huge";
    const listed = await exports.default.catalog();
    expect({
      state: listed.composio,
      entries: listed.entries.length,
      readPastCap: composio.hugeSent.bytes > 5 * 1024 * 1024,
      readAll: composio.hugeSent.bytes >= hugeAnswerBytes,
    }).toStrictEqual({
      state: "unavailable",
      entries: 2,
      readPastCap: false,
      readAll: false,
    });
  });

  it("never logs connect's Composio key", async () => {
    const lines: unknown[] = [];
    for (const method of ["info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      });
    }
    await exports.default.catalog();
    composio.health = "down";
    await exports.default.catalog();
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(testComposioKey);
  });
});

describe("a catalog entry's tools", () => {
  /** The tool lists connect asked Composio for, by path. */
  const toolRequests = (): string[] =>
    composio.requests
      .map(({ path }) => path)
      .filter((path) => path.startsWith("/tools"));

  it("lists a Composio toolkit's tools by the names its server gives them, read-only only where Composio tags them so", async () => {
    await expect(
      exports.default.catalogTools({
        source: "composio",
        id: "hubspot",
      })
    ).resolves.toStrictEqual([
      {
        name: "HUBSPOT_LIST_CONTACTS",
        description: "List contacts",
        inputs: ["limit", "after"],
        readOnly: true,
      },
      {
        name: "HUBSPOT_CREATE_CONTACT",
        description: "Create a contact",
        inputs: [],
        readOnly: false,
      },
      {
        name: "HUBSPOT_DELETE_CONTACT",
        description: null,
        inputs: [],
        readOnly: false,
      },
    ]);
    expect(toolRequests()).toStrictEqual([
      "/tools?toolkit_slug=hubspot&limit=200",
      "/tools?toolkit_slug=hubspot&limit=200&cursor=2",
    ]);
  });

  it("lists a tool whose tags it can't read as one that changes things", async () => {
    const tools = await exports.default.catalogTools({
      source: "composio",
      id: "notion",
    });
    expect(tools.map(({ name, readOnly }) => [name, readOnly])).toStrictEqual([
      ["NOTION_SEARCH", true],
      ["NOTION_NOT_STRINGS", false],
      ["NOTION_TOO_LONG", false],
      ["NOTION_TOO_MANY", false],
      ["NOTION_NOT_A_LIST", false],
    ]);
  });

  it("keeps a toolkit's tools for ten minutes, for that toolkit only", async () => {
    const hubspot = {
      source: "composio",
      id: "hubspot",
    } as const;
    const first = await exports.default.catalogTools(hubspot);
    await expect(exports.default.catalogTools(hubspot)).resolves.toStrictEqual(
      first
    );
    await exports.default.catalogTools({ ...hubspot, id: "linear" });
    expect(toolRequests()).toStrictEqual([
      "/tools?toolkit_slug=hubspot&limit=200",
      "/tools?toolkit_slug=hubspot&limit=200&cursor=2",
      "/tools?toolkit_slug=linear&limit=200",
    ]);
  });

  it("lists a native provider's tools from its connector's manifest", async () => {
    const tools = await exports.default.catalogTools({
      source: "native",
      id: "microsoft",
    });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(({ description }) => description === null)).toBeTruthy();
    // Its input properties, as its manifest declares them.
    expect(tools.some(({ inputs }) => inputs.length > 0)).toBeTruthy();
    // Read-only as its manifest says: its reads, and not its writes.
    const readOnlyOf = Object.fromEntries(
      tools.map(({ name, readOnly }) => [name, readOnly])
    );
    expect(readOnlyOf).toMatchObject({
      "mail.list": true,
      "mail.send": false,
    });
    expect(composio.requests).toStrictEqual([]);
  });

  it("finds no entry that isn't in the catalog", async () => {
    const requests = [
      { source: "composio", id: "nobody" },
      { source: "composio", id: "../toolkits" },
      // Toolkits Composio lists, but the catalog doesn't.
      { source: "composio", id: "acme_erp" },
      { source: "composio", id: "empty_kit" },
      { source: "composio", id: "no_count" },
      { source: "native", id: "hubspot" },
    ] as const;
    const ends = await Promise.all(
      requests.map(
        async (request) => await outcome(exports.default.catalogTools(request))
      )
    );
    expect(ends).toStrictEqual(
      requests.map(() => "connect.catalog_entry_not_found")
    );
    // None of them has its tools asked for.
    expect(toolRequests()).toStrictEqual([]);
  });

  it("says Composio is unavailable when it refuses to list a listed toolkit's tools", async () => {
    const ends = [];
    for (const status of [400, 404]) {
      composio.toolsStatus = status;
      ends.push(
        // oxlint-disable-next-line no-await-in-loop -- one answer at a time
        await outcome(
          exports.default.catalogTools({
            source: "composio",
            id: "hubspot",
          })
        )
      );
    }
    expect(ends).toStrictEqual([
      "connect.catalog_unavailable",
      "connect.catalog_unavailable",
    ]);
  });

  it("says Composio is unavailable when it fails", async () => {
    composio.health = "down";
    const failed = await exports.default
      .catalogTools({ source: "composio", id: "hubspot" })
      .catch((error: unknown) => error);
    expect(connectErrors.codeOf(failed)).toBe("connect.catalog_unavailable");
  });

  it("refuses a request it can't read", async () => {
    await expect(
      outcome(
        exports.default.catalogTools({
          source: "elsewhere",
          id: "hubspot",
        })
      )
    ).resolves.toBe("connect.invalid");
  });
});
