/**
 * Composio's REST API as the connect Worker reaches it in core's tests:
 * part of the `connect-providers` Worker (test/connect-providers.ts), so
 * the real connect runs unchanged behind core. It lists one toolkit,
 * HubSpot, and an admin's auth at its link succeeds at once: the link it
 * gives is the callback connect asked it to send the browser back to.
 * Imported by vite.config.ts (Node) and the tests (workerd), so it only
 * holds data.
 */
import { testComposioKey } from "../../connect/test/provider-config.ts";

/** Composio's toolkits, as its API lists them in core's tests. */
export const composioToolkits = [
  {
    slug: "hubspot",
    name: "HubSpot",
    composio_managed_auth_schemes: ["OAUTH2"],
    meta: {
      categories: [{ id: "crm", name: "CRM" }],
      tools_count: 2,
    },
  },
];

/** HubSpot's tools, as Composio's API lists them. */
export const composioTools = [
  "HUBSPOT_LIST_CONTACTS",
  "HUBSPOT_CREATE_CONTACT",
];

/** The API, as script for the `connect-providers` Worker. */
export const composioApiScript = `
const composioAccounts = new Map();
const composioApi = async (request, url) => {
  if (request.headers.get("x-api-key") !== ${JSON.stringify(testComposioKey)}) {
    return new Response("Unauthorized", { status: 401 });
  }
  const route = url.pathname.slice("/api/v3.1".length);
  if (route === "/toolkits") {
    return Response.json({ items: ${JSON.stringify(composioToolkits)}, next_cursor: null });
  }
  if (route === "/tools") {
    const tools = url.searchParams.get("toolkit_slug") === "hubspot" ? ${JSON.stringify(composioTools)} : [];
    return Response.json({ items: tools.map((slug) => ({ slug })), next_cursor: null });
  }
  if (request.method === "POST" && route === "/auth_configs") {
    return Response.json({ auth_config: { id: "ac_" + crypto.randomUUID() } });
  }
  if (request.method === "POST" && route === "/connected_accounts/link") {
    const { auth_config_id, callback_url } = await request.json();
    const id = "ca_" + crypto.randomUUID();
    composioAccounts.set(id, auth_config_id);
    return Response.json({ redirect_url: callback_url, connected_account_id: id });
  }
  if (request.method === "GET" && route.startsWith("/connected_accounts/")) {
    const id = route.slice("/connected_accounts/".length);
    return Response.json({
      id,
      status: "ACTIVE",
      toolkit: { slug: "hubspot" },
      auth_config: { id: composioAccounts.get(id) },
    });
  }
  if (request.method === "POST" && route === "/mcp/servers") {
    return Response.json({ id: crypto.randomUUID() });
  }
  if (request.method === "POST" && route === "/mcp/servers/generate") {
    const { mcp_server_id, connected_account_ids } = await request.json();
    return Response.json({
      connected_account_urls: connected_account_ids.map(
        (id) => "https://backend.composio.dev/v3/mcp/" + mcp_server_id + "?connected_account_id=" + id
      ),
    });
  }
  if (request.method === "DELETE") {
    return Response.json({ success: true });
  }
  return new Response("Not found", { status: 404 });
};
`;
