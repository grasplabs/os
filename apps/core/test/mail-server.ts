/**
 * A mail provider's MCP server behind a Composio connection, as the connect
 * Worker reaches it in core's tests: part of the `connect-providers` Worker
 * (test/connect-providers.ts), so the real connect runs unchanged behind
 * core. It has one tool, `mail.send`, and records every call that reached
 * it and every mail it really sent. Each server (by the name in its URL)
 * answers its next calls as a test plans them. Imported by vite.config.ts
 * (Node) and the tests (workerd), so it only holds data.
 */

/** A server's URL, as its connection stores it. */
export const mailServerUrl = (name: string): string =>
  `https://backend.composio.dev/v3/mcp/${name}?user_id=grasp`;

/** Where tests plan a server's calls and read what it did. */
export const mailControlUrl = (name: string): string =>
  `https://mail-control.test/${name}`;

/**
 * How the server answers its next call: `unavailable` (a 503 to the call's
 * look at its tools, before anything is sent); or, to the call itself,
 * `sent` (it sends the mail) or `invalid` (the tool refuses the input and
 * says so in its result).
 */
export type MailAnswer = "sent" | "unavailable" | "invalid";

/** The server, as script for the `connect-providers` Worker. */
export const mailServerScript = `
const mailServers = new Map();
const mailServerNamed = (name) => {
  let server = mailServers.get(name);
  if (!server) {
    server = { plan: [], calls: 0, sent: [] };
    mailServers.set(name, server);
  }
  return server;
};
const rpcResult = (id, result) => Response.json({ jsonrpc: "2.0", id, result });

const mailServer = async (request, url) => {
  if (url.hostname === "mail-control.test") {
    const server = mailServerNamed(url.pathname.slice(1));
    if (request.method === "POST") {
      server.plan = (await request.json()).plan;
      return new Response(null, { status: 204 });
    }
    return Response.json({ calls: server.calls, sent: server.sent });
  }
  const server = mailServerNamed(url.pathname.split("/").at(-1));
  const { id, method, params } = await request.json();
  if (id === undefined) {
    return new Response(null, { status: 202 });
  }
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "mail", version: "1.0.0" },
    });
  }
  if (method === "tools/list") {
    if (server.plan[0] === "unavailable") {
      server.plan.shift();
      return new Response("Service Unavailable", { status: 503 });
    }
    return rpcResult(id, {
      tools: [{ name: "mail.send", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } }],
    });
  }
  const answer = server.plan.shift() ?? "sent";
  server.calls += 1;
  if (answer === "invalid") {
    return rpcResult(id, { content: [{ type: "text", text: "Invalid recipient" }], isError: true });
  }
  const { to, subject } = params.arguments;
  server.sent.push({ to, subject });
  const sent = { messageId: "message-" + server.sent.length };
  return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(sent) }], structuredContent: sent });
};
`;
