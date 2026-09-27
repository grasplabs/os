import { connectErrors } from "@grasp-os/shared/connect";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { catalog } from "../src/catalog.ts";
import { fakeComposioApi } from "./composio-api.ts";
import type { FakeToolkit } from "./composio-api.ts";
import { outcome } from "./connect.ts";
import { testComposioKey } from "./provider-config.ts";

// The catalog: the native providers of this release, then Composio's
// toolkits, each marked with who carries out its actions. Composio's are
// listed only while core's `composio` flag is on and connect has its key,
// and Composio failing leaves the native ones listed.

const toolkits: FakeToolkit[] = [
  {
    slug: "hubspot",
    name: "HubSpot",
    logo: "https://logos.composio.dev/api/hubspot",
    categories: ["CRM", "Marketing"],
    tools: [
      { slug: "HUBSPOT_LIST_CONTACTS", description: "List contacts" },
      { slug: "HUBSPOT_CREATE_CONTACT", description: "Create a contact" },
      { slug: "HUBSPOT_DELETE_CONTACT" },
    ],
  },
  {
    slug: "linear",
    name: "Linear",
    logo: "http://logos.example/linear",
    tools: [{ slug: "LINEAR_LIST_ISSUES" }],
  },
  // Composio holds no app for it: an admin would need one of their own.
  { slug: "acme_erp", name: "Acme ERP", managed: false, tools: [] },
  {
    slug: "notion",
    name: "Notion",
    logo: "https://user:pass@logos.example/notion",
    tools: [{ slug: "NOTION_SEARCH" }],
  },
];

const composio = fakeComposioApi(toolkits, {
  // Items connect can't read, among the rest.
  extra: [{ slug: "Not A Slug", name: "Broken" }, { name: "No slug" }, 42],
});

describe("the catalog", () => {
  it("lists the native providers, then Composio's toolkits, each marked", async () => {
    const listed = await exports.default.catalog({ composio: true });
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
      logo: "https://logos.composio.dev/api/hubspot",
      categories: ["CRM", "Marketing"],
      toolCount: 3,
    });
  });

  it("reads every page of Composio's list, with connect's key, following no redirect", async () => {
    await exports.default.catalog({ composio: true });
    // Four toolkits and three unreadable items, two to a page.
    expect(composio.requests).toHaveLength(4);
    expect(
      composio.requests.every(
        ({ method, keyed, followsRedirects }) =>
          method === "GET" && keyed && !followsRedirects
      )
    ).toBeTruthy();
  });

  it("leaves out toolkits Composio holds no app for, and items it can't read", async () => {
    const { entries } = await exports.default.catalog({ composio: true });
    const ids = entries.map(({ id }) => id);
    expect(ids).not.toContain("acme_erp");
    expect(ids).toHaveLength(5);
  });

  it("gives only HTTPS logos without credentials in them", async () => {
    const { entries } = await exports.default.catalog({ composio: true });
    const logos = Object.fromEntries(entries.map(({ id, logo }) => [id, logo]));
    expect(logos).toMatchObject({
      microsoft: null,
      hubspot: "https://logos.composio.dev/api/hubspot",
      linear: null,
      notion: null,
    });
  });

  it("gives each native provider's tool count as its tools list them", async () => {
    const { entries } = await exports.default.catalog({ composio: false });
    const counts = await Promise.all(
      entries.map(async ({ source, id, toolCount }) => {
        const tools = await exports.default.catalogTools({
          composio: false,
          source,
          id,
        });
        return toolCount > 0 && tools.length === toolCount;
      })
    );
    expect(counts).toStrictEqual([true, true]);
  });

  it("lists only the native providers while the flag is off, without asking Composio", async () => {
    const listed = await exports.default.catalog({ composio: false });
    expect(listed.composio).toBe("off");
    expect(listed.entries.map(({ source }) => source)).toStrictEqual([
      "native",
      "native",
    ]);
    expect(composio.requests).toStrictEqual([]);
  });

  it("lists only the native providers while connect has no Composio key", async () => {
    const results = await Promise.all(
      [undefined, ""].map(
        async (key) =>
          await catalog({ ...env, COMPOSIO_API_KEY: key }, { composio: true })
      )
    );
    expect(results.map(({ composio: state }) => state)).toStrictEqual([
      "off",
      "off",
    ]);
    expect(composio.requests).toStrictEqual([]);
  });

  it("still lists the native providers when Composio fails", async () => {
    const failures = ["down", "redirect", "garbled"] as const;
    const results = [];
    for (const failure of failures) {
      composio.health = failure;
      // oxlint-disable-next-line no-await-in-loop -- one failure at a time
      results.push(await exports.default.catalog({ composio: true }));
    }
    expect(
      results.map(({ composio: state, entries }) => [state, entries.length])
    ).toStrictEqual(failures.map(() => ["unavailable", 2]));
  });

  it("never logs connect's Composio key", async () => {
    const lines: unknown[] = [];
    for (const method of ["info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      });
    }
    await exports.default.catalog({ composio: true });
    composio.health = "down";
    await exports.default.catalog({ composio: true });
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(testComposioKey);
  });

  it("refuses a request it can't read", async () => {
    await expect(
      outcome(exports.default.catalog({ composio: "yes" }))
    ).resolves.toBe("connect.invalid");
  });
});

describe("a catalog entry's tools", () => {
  it("lists a Composio toolkit's tools by the names its server gives them", async () => {
    await expect(
      exports.default.catalogTools({
        composio: true,
        source: "composio",
        id: "hubspot",
      })
    ).resolves.toStrictEqual([
      { name: "HUBSPOT_LIST_CONTACTS", description: "List contacts" },
      { name: "HUBSPOT_CREATE_CONTACT", description: "Create a contact" },
      { name: "HUBSPOT_DELETE_CONTACT", description: null },
    ]);
    expect(composio.requests.map(({ path }) => path)).toStrictEqual([
      "/tools?toolkit_slug=hubspot&limit=1000",
      "/tools?toolkit_slug=hubspot&limit=1000&cursor=2",
    ]);
  });

  it("lists a native provider's tools from its connector's manifest", async () => {
    const tools = await exports.default.catalogTools({
      composio: false,
      source: "native",
      id: "microsoft",
    });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every(({ description }) => description === null)).toBeTruthy();
    expect(composio.requests).toStrictEqual([]);
  });

  it("finds no entry that isn't in the catalog", async () => {
    const requests = [
      { composio: true, source: "composio", id: "nobody" },
      { composio: true, source: "composio", id: "../toolkits" },
      { composio: true, source: "native", id: "hubspot" },
      // Off, Composio's toolkits aren't in the catalog.
      { composio: false, source: "composio", id: "hubspot" },
    ] as const;
    const ends = await Promise.all(
      requests.map(
        async (request) => await outcome(exports.default.catalogTools(request))
      )
    );
    expect(ends).toStrictEqual(
      requests.map(() => "connect.catalog_entry_not_found")
    );
    // Only the well-formed toolkit, while the flag is on, was looked up.
    expect(composio.requests.map(({ path }) => path)).toStrictEqual([
      "/tools?toolkit_slug=nobody&limit=1000",
    ]);
  });

  it("finds no toolkit Composio refuses to list tools for", async () => {
    composio.health = "refusing";
    await expect(
      outcome(
        exports.default.catalogTools({
          composio: true,
          source: "composio",
          id: "hubspot",
        })
      )
    ).resolves.toBe("connect.catalog_entry_not_found");
  });

  it("says Composio is unavailable when it fails", async () => {
    composio.health = "down";
    const failed = await exports.default
      .catalogTools({ composio: true, source: "composio", id: "hubspot" })
      .catch((error: unknown) => error);
    expect(connectErrors.codeOf(failed)).toBe("connect.catalog_unavailable");
  });

  it("refuses a request it can't read", async () => {
    await expect(
      outcome(
        exports.default.catalogTools({
          composio: true,
          source: "elsewhere",
          id: "hubspot",
        })
      )
    ).resolves.toBe("connect.invalid");
  });
});
