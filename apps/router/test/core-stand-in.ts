/**
 * A Worker standing in for a client's core, set as the router's outbound
 * service in vite.config.ts: every request the router sends with the real
 * `fetch` lands here, whatever its host. The router's own check still
 * decides which hosts it sends to (only https `*.workers.dev` origins), so
 * that check runs unchanged; this only takes the place of the internet
 * behind it. It answers with what reached it, echoes WebSocket messages, and
 * redirects on `/redirect`. Imported by vite.config.ts (Node) and the tests
 * (workerd), so it only holds data.
 */

/** Where the stand-in's `/redirect` sends the caller. */
export const standInRedirect = "https://login.example.com/authorize";

export const coreStandInScript = `
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("upgrade") === "websocket") {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      server.addEventListener("message", (event) => {
        server.send("echo: " + event.data);
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: ${JSON.stringify(standInRedirect)} },
      });
    }
    return Response.json({
      url: request.url,
      method: request.method,
      host: request.headers.get("host"),
      secret: request.headers.get("x-grasp-router-secret"),
      clientIp: request.headers.get("x-grasp-client-ip"),
      body: await request.text(),
    });
  },
};
`;
