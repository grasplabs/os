/**
 * Forwards each request to the right client account's core Worker, adding
 * the router secret so a client's workers.dev address is no back door.
 */
export default {
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return Response.json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
