import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { sessionEndedCloseCode } from "../src/rpc.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin } from "./sign-in-config.ts";
import {
  callAuth,
  coreOrigin,
  entraPerson,
  openRpc,
  outcome,
  routed,
  signedIn,
  whoami,
} from "./sign-in.ts";

const idp = mockIdp();

const hour = 60 * 60 * 1000;
const clientHost = new URL(clientOrigin).host;

describe("sessions end", () => {
  it("after twelve hours, and aren't extended by use", async () => {
    const startedAt = Date.now();
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const first = await whoami(session);
    const again = await whoami(session);

    expect(Date.parse(first.expiresAt)).toBeGreaterThan(startedAt);
    expect(Date.parse(first.expiresAt)).toBeLessThanOrEqual(
      startedAt + 12 * hour + 1000
    );
    expect(again.expiresAt).toBe(first.expiresAt);
  });

  it("when they expire", async () => {
    const person = entraPerson(acmeTenant);
    const session = await signedIn(idp, "microsoft", person);
    // Twelve hours pass.
    await env.DB.prepare(
      "UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT user_id FROM accounts WHERE account_id = ?)"
    )
      .bind(Date.now() - 1000, person.sub)
      .run();

    await expect(outcome(whoami(session))).resolves.toBe(
      "auth.unauthenticated"
    );
    const response = await callAuth("/get-session", session);
    await expect(response.json()).resolves.toBeNull();
  });

  it("when the person signs out", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const signedOut = await callAuth("/sign-out", session, {});
    expect(signedOut.status).toBe(200);

    await expect(outcome(whoami(session))).resolves.toBe(
      "auth.unauthenticated"
    );
  });

  it("when the person revokes them from another session", async () => {
    const person = entraPerson(acmeTenant);
    const laptop = await signedIn(idp, "microsoft", person);
    const phone = await signedIn(idp, "microsoft", person);

    const revoked = await callAuth("/revoke-other-sessions", laptop, {});
    expect(revoked.status).toBe(200);
    await expect(outcome(whoami(phone))).resolves.toBe("auth.unauthenticated");
    await expect(whoami(laptop)).resolves.toMatchObject({
      email: person.email,
    });
  });

  it("on an open connection too: its next call is refused and it closes", async () => {
    const person = entraPerson(acmeTenant);
    const laptop = await signedIn(idp, "microsoft", person);
    const phone = await signedIn(idp, "microsoft", person);
    const { core, closed } = await openRpc(phone);
    using session = core.authenticate();
    await expect(session.whoami()).resolves.toMatchObject({
      email: person.email,
    });

    await callAuth("/revoke-other-sessions", laptop, {});
    await expect(outcome(session.whoami())).resolves.toBe(
      "auth.unauthenticated"
    );
    await expect(closed).resolves.toBe(sessionEndedCloseCode);
  });
});

describe("cross-site WebSocket upgrades", () => {
  it("are refused, even with a valid session", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const origins = [
      "https://evil.example",
      `https://${clientHost}.evil.example`,
      `https://evil.${clientHost}`,
      `http://${clientHost}`,
      // Core's own address is not the client's hostname the router forwards.
      coreOrigin,
      "null",
    ];
    const responses = await Promise.all(
      origins.map(
        async (origin) =>
          await routed("/rpc", {
            headers: { Upgrade: "websocket", Origin: origin, cookie: session },
          })
      )
    );
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.webSocket).toBeNull();
    }
  });

  it("are refused without an Origin", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const response = await routed("/rpc", {
      headers: { Upgrade: "websocket", cookie: session },
    });
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("from the client's own page are accepted", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const response = await routed("/rpc", {
      headers: { Upgrade: "websocket", Origin: clientOrigin, cookie: session },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});
