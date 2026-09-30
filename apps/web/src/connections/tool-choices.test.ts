import type { CatalogTool } from "@grasp-os/shared/connect";
import { composioToolsSchema } from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";

import { toolRules, withAllowed, withRead } from "./tool-choices.ts";

// What the dialog for connecting a Composio toolkit submits: a tool wrongly
// submitted as a read runs without asking its person, so the default for a
// tool Composio doesn't tag read-only must be a side effect.

const tool = (name: string, readOnly: boolean): CatalogTool => ({
  name,
  description: null,
  inputs: [],
  readOnly,
});

const list = tool("HUBSPOT_LIST_CONTACTS", true);
const create = tool("HUBSPOT_CREATE_CONTACT", false);

describe("the tools an admin allows", () => {
  it("start as Composio's hint says: a read where it tags one, a side effect where it doesn't", () => {
    const allowed = withAllowed(withAllowed([], list, true), create, true);
    expect(toolRules(allowed)).toStrictEqual([
      { name: "HUBSPOT_LIST_CONTACTS", read: true },
      "HUBSPOT_CREATE_CONTACT",
    ]);
  });

  it("are read-only or not as the admin then says, whatever the hint", () => {
    const allowed = withAllowed(withAllowed([], list, true), create, true);
    const changed = withRead(
      withRead(allowed, list.name, false),
      create.name,
      true
    );
    expect(toolRules(changed)).toStrictEqual([
      "HUBSPOT_LIST_CONTACTS",
      { name: "HUBSPOT_CREATE_CONTACT", read: true },
    ]);
    // Ticked and unticked again: a side effect, as it started.
    expect(toolRules(withRead(changed, create.name, false))).toStrictEqual([
      "HUBSPOT_LIST_CONTACTS",
      "HUBSPOT_CREATE_CONTACT",
    ]);
  });

  it("are left out once no longer allowed, and start from the hint again when allowed again", () => {
    const marked = withRead(withAllowed([], create, true), create.name, true);
    const removed = withAllowed(marked, create, false);
    expect(toolRules(removed)).toStrictEqual([]);
    expect(toolRules(withAllowed(removed, create, true))).toStrictEqual([
      "HUBSPOT_CREATE_CONTACT",
    ]);
  });

  it("are each submitted once, and never marked without being allowed", () => {
    const twice = withAllowed(withAllowed([], list, true), list, true);
    const notAllowed = withRead(twice, create.name, true);
    expect(toolRules(notAllowed)).toStrictEqual([
      { name: "HUBSPOT_LIST_CONTACTS", read: true },
    ]);
    // What connect takes: its schema reads what the dialog submits.
    expect(
      composioToolsSchema.safeParse(toolRules(notAllowed)).success
    ).toBeTruthy();
  });
});
