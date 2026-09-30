import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";
import { origin } from "./stack.ts";

// The side panel of a chat previews the draft its agent is writing: the
// draft's screen, calling the draft's server code in a preview of its own,
// which changes none of the App's data. The local stack reaches no model,
// so the draft is written straight into the chat's Workspace object, as
// the agent's `env.build.write` leaves it, through the local dev server's
// own tools (as connections-seed.ts writes into connect's database). The
// agent's side of it, and what the preview reports back to it, are core's
// tests (apps/core/test/preview-repairs.test.ts).

/** Where the local dev server runs SQL in a Durable Object's storage. */
const explorer = new URL("/cdn-cgi/local/explorer/api/", origin);

const namespacesSchema = {
  parse: (value: unknown): { id: string; class: string }[] => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("result" in value) ||
      !Array.isArray(value.result)
    ) {
      throw new TypeError("The dev server listed no Durable Objects");
    }
    return value.result.flatMap((entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      typeof entry.id === "string" &&
      "class" in entry &&
      typeof entry.class === "string"
        ? [{ id: entry.id, class: entry.class }]
        : []
    );
  },
};

/**
 * Writes a draft of `app` over `base`, with `files`, into `chatId` in
 * `userId`'s Workspace object (core's chats-rpc.ts names it), as its
 * agent's first write does.
 */
const writeDraft = async (
  userId: string,
  chatId: string,
  app: string,
  base: number,
  files: Record<string, string>
): Promise<void> => {
  const listed = await fetch(
    new URL("workers/durable_objects/namespaces", explorer)
  );
  const workspaces = namespacesSchema
    .parse(await listed.json())
    .find((namespace) => namespace.class === "Workspace");
  if (workspaces === undefined) {
    throw new Error("The dev server has no Workspace objects");
  }
  const written = await fetch(
    new URL(
      `workers/durable_objects/namespaces/${encodeURIComponent(workspaces.id)}/query`,
      explorer
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        durable_object_name: `person:${userId}`,
        queries: [
          {
            sql: "INSERT INTO chat_drafts (chat_id, app_id, base, revision, updated_at) VALUES (?, ?, ?, 1, ?)",
            params: [chatId, app, base, Date.now()],
          },
          ...Object.entries(files).map(([path, content]) => ({
            sql: "INSERT INTO chat_draft_files (chat_id, app_id, path, content) VALUES (?, ?, ?, ?)",
            params: [chatId, app, path, content],
          })),
        ],
      }),
    }
  );
  if (!written.ok) {
    throw new Error(`The draft wasn't written: ${await written.text()}`);
  }
};

/** Server code that counts, in its storage, what was added. */
const server = (
  label: string
) => `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  add(): string {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tally (n INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO tally VALUES (1)");
    return this.count();
  }

  count(): string {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tally (n INTEGER)");
    const [row] = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM tally").toArray();
    return \`\${String(row?.n ?? 0)} ${label}\`;
  }
}
`;

const screen = `import { callServer } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";

export default function Tally() {
  const [tally, setTally] = useState("none yet");
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button onClick={() => { void callServer<string>("add").then(setTally); }} variant="outline">
        Add one
      </Button>
      <output>{tally}</output>
    </main>
  );
}
`;

test("the side panel previews the chat's draft, whose server code changes none of the App's data", async ({
  browser,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Tally ${tag}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await api.apps.files.commit(
      app.id,
      { "screens/tally.tsx": screen, "app/server.ts": server("in the App") },
      "A tally"
    );
    await api.apps.versions.setCurrent(app.id, version);
    const chat = await api.chats.create(`Preview ${tag}`);
    await writeDraft(builder.userId, chat.id, app.id, version, {
      "app/server.ts": server("in the preview"),
    });

    const page = await pageOf(browser, builder);
    await page.goto(`/?chat=${chat.id}`);
    await page.getByRole("button", { name: "Side panel" }).click();
    const preview = page
      .getByRole("complementary", { name: "Side panel" })
      .getByRole("region", { name: `Preview of ${name}` });
    await expect(preview).toContainText(
      "Preview: changes nothing, reads no real data"
    );
    await expect(preview).toContainText(name);
    const frame = preview.frameLocator("iframe");
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("1 in the preview");
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("2 in the preview");

    // The App's own storage has none of it.
    const counted = await api.screens.call(app.id, "count", []);
    expect(counted).toBe("0 in the App");
  } finally {
    core[Symbol.dispose]();
  }
});
