import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// The side panel of a chat shows the App being built: a version up for
// review, with what core says it changes, and a builder making it
// current from there. The local stack reaches no model, so the version is
// proposed through the builder's own API, as the chat's agent proposes
// one (`env.build.propose`); the agent's drafts, checks and proposals
// themselves are core's tests (apps/core/test/agent-builds.test.ts).

const screen = `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button variant="outline">Approve</Button>
    </main>
  );
}
`;

test("the side panel shows an App being built, and a builder makes its version current", async ({
  browser,
}) => {
  const { builder } = peopleIn("chatBuilds");
  const { core, api } = apiOf(builder);
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Invoice desk ${tag}`;
  try {
    const app = await api.apps.create({ name });
    await api.apps.files.write(app.id, { "screens/desk.tsx": screen });
    const { version } = await api.apps.files.commit(
      app.id,
      "An invoice desk for invoices@"
    );
    await api.apps.versions.propose(app.id, version);
    const chat = await api.chats.create(`Build ${tag}`);

    const page = await pageOf(browser, builder);
    await page.goto(`/?chat=${chat.id}`);
    await page.getByRole("button", { name: "Side panel" }).click();
    const built = page
      .getByRole("complementary", { name: "Side panel" })
      .getByRole("region", { name: "Being built" });
    await expect(built).toContainText(
      `${name}: version ${version} waiting for review`
    );
    await expect(built.getByRole("region", { name: "Files" })).toHaveText(
      /Added screens\/desk\.tsx/u
    );
    await expect(built).toContainText(
      "Nothing runs yet: this would be the App's first current version."
    );
    // Who proposed it, and the proposer's own words, labelled as such.
    await expect(built).toContainText("Committed by a person.");
    await expect(built.getByRole("blockquote")).toHaveText(
      "In the proposer's wordsAn invoice desk for invoices@"
    );
    await expect(built.getByRole("region", { name: "Tests" })).toContainText(
      "No workflows to test."
    );

    await built
      .getByRole("button", { name: `Make version ${version} current` })
      .click();
    await expect(built).toHaveCount(0);
    await expect
      .poll(async () => {
        const listed = await api.apps.list();
        return listed.find(({ id }) => id === app.id)?.currentVersion;
      })
      .toBe(version);
  } finally {
    core[Symbol.dispose]();
  }
});
