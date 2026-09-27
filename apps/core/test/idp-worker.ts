/**
 * The fake IdP as a Worker of its own, for local development (`vp run dev`)
 * and the end-to-end tests: core's Entra sign-in goes here instead of to
 * Microsoft (`DEV_IDP_ORIGIN`, src/auth/config.ts). Whoever signs in is a
 * member of the tenant they sign in to, with the email they give: the
 * `login_hint` core passes on, or else one typed into the form here.
 */
import { createIdp } from "./fake-idp.ts";
import type { Idp } from "./fake-idp.ts";
import { localAdmin } from "./sign-in-config.ts";

/** An IdP for each origin the Worker is reached at, created on first use. */
const idps = new Map<string, Idp>();

const idpAt = (origin: string): Idp => {
  const idp = idps.get(origin) ?? createIdp(origin);
  idps.set(origin, idp);
  return idp;
};

const wordBreak = /[.@+_-]/u;

/** A name from the email's first word: Ada for ada.lovelace@acme.test. */
const nameOf = (email: string): string => {
  const [word = ""] = email.split(wordBreak);
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
};

const authorizePath = /^\/(?<tenant>[^/]+)\/oauth2\/v2\.0\/authorize$/u;

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Asks for an email, and sends the authorization request again with it. */
const emailForm = (url: URL): Response => {
  const fields = [...url.searchParams]
    .filter(([name]) => name !== "login_hint")
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
    )
    .join("");
  return new Response(
    `<!doctype html><title>Local sign-in</title>
<form method="get" action="${escapeHtml(url.pathname)}">${fields}
<label>Email <input name="login_hint" type="email" value="${localAdmin}" required></label>
<button>Sign in</button></form>`,
    { headers: { "content-type": "text/html; charset=utf-8" } }
  );
};

export default {
  fetch: async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const idp = idpAt(url.origin);
    const tenant = authorizePath.exec(url.pathname)?.groups?.tenant;
    if (tenant !== undefined && request.method === "GET") {
      const email = url.searchParams.get("login_hint")?.toLowerCase();
      if (email === undefined || email === "") {
        return emailForm(url);
      }
      const callback = idp.authorize(url, {
        sub: `sub-${email}`,
        oid: `oid-${email}`,
        tid: tenant,
        // A member of the tenant, not a B2B guest.
        acct: 0,
        email,
        name: nameOf(email),
      });
      return Response.redirect(callback.href, 302);
    }
    try {
      return await idp.fetch(request);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  },
};
