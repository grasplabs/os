import type { CatalogTool, ComposioToolRule } from "@grasp-os/shared/connect";

// What the admin chose in the dialog for connecting a Composio toolkit:
// which tools to allow, and which of those only read. Kept apart from the
// dialog so what it submits can be tested without Composio.

/** One tool the admin allows, and whether they say it only reads. */
export interface AllowedTool {
  name: string;
  read: boolean;
}

/**
 * `allowed` after the admin allows `tool` or stops allowing it. A tool
 * newly allowed starts as Composio's hint says (`CatalogTool.readOnly`):
 * one without the hint changes things until the admin says otherwise.
 */
export const withAllowed = (
  allowed: readonly AllowedTool[],
  tool: CatalogTool,
  allow: boolean
): AllowedTool[] => {
  const others = allowed.filter(({ name }) => name !== tool.name);
  return allow ? [...others, { name: tool.name, read: tool.readOnly }] : others;
};

/**
 * `allowed` after the admin says whether the allowed tool `name` only
 * reads. A tool that isn't allowed stays out.
 */
export const withRead = (
  allowed: readonly AllowedTool[],
  name: string,
  read: boolean
): AllowedTool[] =>
  allowed.map((tool) => (tool.name === name ? { name, read } : tool));

/**
 * What connecting submits: a tool marked read-only with its rule, any other
 * by name alone, which connect takes for a side effect.
 */
export const toolRules = (
  allowed: readonly AllowedTool[]
): (string | ComposioToolRule)[] =>
  allowed.map(({ name, read }) => (read ? { name, read } : name));
