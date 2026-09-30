import { expect } from "@playwright/test";

import { execute } from "./connections-seed.ts";
import { test } from "./csp.ts";
import { pageOf, peopleIn } from "./people.ts";
import type { Person } from "./people.ts";

// The Chat page: a person asks in a new chat and follows the answer as it
// comes in, renames the chat, and confirms and rejects a write its agent
// holds for them, and sees nothing of held writes while they are switched
// off. The local stack reaches no model, so the answer is the
// gateway's failure; streaming, resuming and the person check themselves
// are core's tests (apps/core/test/chats.test.ts).

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * A write the chat's agent asked for, as connect holds it for `person`:
 * written straight into connect's local database, as a call from the
 * chat's code would leave it (held-writes are core's tests too).
 */
const holdWrite = async (person: Person, chatId: string): Promise<void> => {
  const context = JSON.stringify({
    type: "chat",
    // The person's own chats' object, and the organization's agent.
    workspaceId: `person:${person.userId}`,
    chatId,
  });
  const input = JSON.stringify({ to: "ben@acme.test", subject: "Invoice" });
  const values = [
    quoted(crypto.randomUUID()),
    quoted("agent"),
    quoted("organization"),
    quoted(person.userId),
    quoted("interactive"),
    "NULL",
    quoted(crypto.randomUUID()),
    "NULL",
    "NULL",
    quoted("mail.send"),
    quoted(`chat:${crypto.randomUUID()}`),
    quoted(input),
    quoted("0".repeat(64)),
    quoted(crypto.randomUUID()),
    quoted(context),
    "0",
    String(Date.now()),
  ];
  await execute(
    `INSERT INTO pending_actions (id, subject_type, subject_id, on_behalf_of, mode, app_version, connection_id, account_id, resource, action, idempotency_key, input, input_hash, permission_id, context, restricted, created_at) VALUES (${values.join(", ")})`
  );
};

test("a person asks in a new chat, follows the answer, renames it, and decides a write it holds", async ({
  browser,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(browser, user);
  // Unique to the attempt, so each finds its own chat in the list.
  const tag = crypto.randomUUID().slice(0, 8);
  const question = `Send Ben invoice ${tag}.`;
  const title = `Invoice ${tag}`;
  await page.goto("/");

  await page.getByLabel("Your question").fill(question);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  const messages = page.getByRole("list", { name: "Messages" });
  await expect(messages.getByRole("listitem").first()).toHaveText(question);
  // No model answers here: the answer says so once the turn ends.
  await expect(messages.getByRole("alert")).toHaveText(
    "The model call failed.",
    { timeout: 30_000 }
  );
  const chats = page.getByRole("navigation", { name: "Chats" });
  await expect(chats.getByRole("link", { name: question })).toBeVisible();

  await page.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  await expect(chats.getByRole("link", { name: title })).toBeVisible();

  const chatId = new URL(page.url()).searchParams.get("chat") ?? "";
  await holdWrite(user, chatId);
  await page.reload();
  const waiting = page.getByRole("region", { name: "Waiting for you" });
  await expect(waiting).toContainText("ben@acme.test");
  // When it was asked for, so an old one isn't taken for a new one.
  await expect(waiting.locator("time")).toHaveAttribute(
    "datetime",
    /^\d{4}-\d{2}-\d{2}T/u
  );
  // Confirming goes through core's checks again: the agent was never
  // granted this connection, so it's refused, and the write still waits.
  await waiting.getByRole("button", { name: /^Confirm/u }).click();
  await expect(waiting.getByRole("alert")).toHaveText(
    "This App or agent has no permission to do that."
  );
  await expect(waiting).toContainText("ben@acme.test");
  // Rejecting it drops it.
  await waiting.getByRole("button", { name: /^Reject/u }).click();
  await expect(waiting).toHaveCount(0);
});

test("a chat shows nothing of held writes while they're switched off", async ({
  browser,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(browser, user);
  const tag = crypto.randomUUID().slice(0, 8);
  await page.goto("/");
  await page.getByLabel("Your question").fill(`Held off ${tag}.`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  const chatId = new URL(page.url()).searchParams.get("chat") ?? "";
  await holdWrite(user, chatId);

  // The page's list of held writes goes to an API this stack has switched
  // off (improvement signals), which core refuses as `feature.disabled`,
  // as it refuses held writes while connections or confirmations are off.
  let refused = 0;
  await page.routeWebSocket("**/rpc", (socket) => {
    const toCore = socket.connectToServer();
    socket.onMessage((message) => {
      const text = String(message);
      if (text.includes('["pendingActions","list"]')) {
        refused += 1;
        toCore.send(
          text.replaceAll('["pendingActions","list"]', '["signals","list"]')
        );
        return;
      }
      toCore.send(text);
    });
  });
  await page.reload();
  await expect.poll(() => refused).toBeGreaterThan(0);
  const messages = page.getByRole("list", { name: "Messages" });
  await expect(messages.getByRole("listitem").first()).toHaveText(
    `Held off ${tag}.`
  );
  await expect(
    page.getByRole("region", { name: "Waiting for you" })
  ).toHaveCount(0);
  await expect(page.getByText("This isn't switched on")).toHaveCount(0);
});

test("the side panel opens over the chat on a narrow screen, and beside it on a wide one", async ({
  browser,
}) => {
  const { user } = peopleIn("chat");
  const page = await pageOf(browser, user);
  const tag = crypto.randomUUID().slice(0, 8);
  await page.goto("/");
  await page.getByLabel("Your question").fill(`Panel ${tag}.`);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/[?&]chat=/u);
  const panel = page.getByRole("complementary", { name: "Side panel" });

  // A phone: over the chat, filling the screen, and closed from itself.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Side panel" }).click();
  await expect(panel).toBeVisible();
  expect(await panel.boundingBox()).toMatchObject({
    x: 0,
    y: 0,
    width: 375,
    height: 812,
  });
  await panel.getByRole("button", { name: "Close" }).click();
  await expect(panel).toHaveCount(0);

  // A wide screen: beside the chat, which keeps its room.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Side panel" }).click();
  await expect(panel.getByRole("button", { name: "Close" })).toBeHidden();
  const beside = await panel.boundingBox();
  const chat = await page
    .getByRole("region", { name: `Panel ${tag}.` })
    .boundingBox();
  expect({
    fits: (beside?.x ?? 0) + (beside?.width ?? 0) <= 1440,
    besideTheChat: (chat?.x ?? 0) + (chat?.width ?? 0) <= (beside?.x ?? 0),
  }).toStrictEqual({ fits: true, besideTheChat: true });
});
