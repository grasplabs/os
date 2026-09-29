/**
 * The outside systems the connect Worker reaches in core's tests: a Worker
 * of its own, set as connect's outbound service in vite.config.ts, so the
 * real connect runs unchanged behind core. Entra ID's token endpoint checks
 * PKCE and Grasp's client secret as Entra does, and issues tokens for the
 * account the code names; Composio's API answers as test/composio-api.ts
 * says; a mail provider's MCP server answers as
 * test/mail-server.ts says; Microsoft Graph's delta queries answer as
 * connect's test/graph-events-fake.ts says, with mail tests post to
 * `graphControlUrl`. Imported by vite.config.ts (Node) and the tests
 * (workerd), so it only holds data.
 */
import { graphEventsFake } from "../../connect/test/graph-events-fake.ts";
import { clients } from "../../connect/test/provider-config.ts";
import { composioApiScript } from "./composio-api.ts";
import { mailServerScript } from "./mail-server.ts";

/** Grasp's Entra app for connections, as set on connect in the tests. */
export const connectClient = clients.microsoft;

/**
 * The code Entra sends back once `subject` in `tenant` consents at `url`:
 * it carries the authorization's PKCE challenge, so only the flow's own
 * verifier redeems it.
 */
export const consentCode = (url: URL, tenant: string, subject: string) =>
  [url.searchParams.get("code_challenge"), tenant, subject].join(".");

/**
 * Where tests post a message arriving in a mailbox's inbox:
 * `{ mailbox, message }`, as Graph's delta queries then show it.
 */
export const graphControlUrl = "https://graph-control.test/receive";

/** The tokens the fake issues for `subject`, to look for where they mustn't be. */
export const tokensFor = (subject: string): string[] => [
  `access.${subject}`,
  `refresh.${subject}`,
];

export const connectProvidersScript = `
${mailServerScript}
${composioApiScript}
const base64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const encoded = (value) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));
const graphEvents = (${graphEventsFake.toString()})();

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === "backend.composio.dev" && url.pathname.startsWith("/api/v3.1/")) {
      return await composioApi(request, url);
    }
    if (url.hostname === "backend.composio.dev" || url.hostname === "mail-control.test") {
      return await mailServer(request, url);
    }
    if (url.hostname === "graph.microsoft.com") {
      return graphEvents.answer(request, url);
    }
    if (request.method === "POST" && url.href === ${JSON.stringify(graphControlUrl)}) {
      const { mailbox, message } = await request.json();
      graphEvents.receive(mailbox, message);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST" || url.hostname !== "login.microsoftonline.com") {
      return new Response("Not found", { status: 404 });
    }
    const form = new URLSearchParams(await request.text());
    const [challenge, tenant, subject] = (form.get("code") ?? "").split(".");
    const verifier = new TextEncoder().encode(form.get("code_verifier") ?? "");
    const digest = base64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", verifier))
    );
    if (form.get("client_secret") !== ${JSON.stringify(connectClient.secret)} || digest !== challenge) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const claims = {
      iss: "https://login.microsoftonline.com/" + tenant + "/v2.0",
      aud: ${JSON.stringify(connectClient.id)},
      tid: tenant,
      oid: subject,
      preferred_username: subject + "@acme.test",
    };
    return Response.json({
      token_type: "Bearer",
      access_token: "access." + subject,
      refresh_token: "refresh." + subject,
      expires_in: 3600,
      id_token: [encoded({ alg: "RS256" }), encoded(claims), "signature"].join("."),
    });
  },
};
`;
