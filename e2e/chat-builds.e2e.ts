import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, pageOf, peopleIn } from "./people.ts";

// The side panel of a chat shows the App being built: a version up for
// review, with what core says it changes, and a builder making it
// current from there. The local stack reaches no model, so the version is
// proposed through the builder's own API, as the chat's agent proposes
// one (`env.build.propose`); the agent's drafts, checks and proposals
// themselves are core's tests (apps/core/test/agent-builds.test.ts).

/** A weekly workflow on a schedule, whose one step books: it acts. */
const weekly = {
  "workflows/weekly.ts": `import { schedule, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "weekly",
  { params: { every: schedule({ label: "Runs", default: "0 8 * * 1" }) }, triggers: [{ type: "schedule", param: "every" }] },
  async (step) => await step.do("book", { description: "Book the week", sideEffect: true, input: "week" }, async () => "booked")
);
`,
  "workflows/weekly.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./weekly.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { book: "booked" }, expect: { output: "booked" } }]);
`,
};

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
    await api.apps.files.write(app.id, {
      "screens/desk.tsx": screen,
      ...weekly,
      // Server code the server build reads, though not app/server.ts.
      "app/lib/format.ts":
        "export const format = (total: number) => String(total);\n",
      // A method other Apps may call, which changes the App's data.
      "app/exports.json": JSON.stringify({
        book: {
          access: "write",
          description: "Book an invoice",
          input: { type: "object" },
          output: { type: "object" },
        },
      }),
    });
    const { version } = await api.apps.files.commit(
      app.id,
      "An invoice desk for invoices@"
    );
    await api.apps.versions.propose(app.id, version);
    const chat = await api.chats.create(`Build ${tag}`);

    const page = await pageOf(browser, builder);
    // The server code's first read goes to an API this stack has switched
    // off (improvement signals), which core refuses: as a read that fails.
    let failServerCode = true;
    await page.routeWebSocket("**/rpc", (socket) => {
      const toCore = socket.connectToServer();
      socket.onMessage((message) => {
        const text = String(message);
        toCore.send(
          failServerCode
            ? text.replaceAll('["apps","files","read"]', '["signals","list"]')
            : text
        );
      });
    });
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
      "All workflow tests pass."
    );
    // Its workflow runs on its own now, and can change things.
    const workflows = built.getByRole("region", { name: "Workflows" });
    await expect(workflows).toContainText("Added workflow weekly");
    await expect(workflows).toContainText(
      "Now runs on a schedule (its parameter every)"
    );
    await expect(workflows).toContainText("May change something outside Grasp");
    // What other Apps may now call, flagged when it changes the App's data.
    const exported = built.getByRole("region", { name: "Exports" });
    await expect(exported).toContainText(
      "Other Apps may now call book, which changes the App's data"
    );
    await expect(exported).toContainText("Changes the App's data");
    // All of its server code is flagged. Until it loads, nothing is made
    // current; once its read failed, it can be read again.
    const serverCode = built.getByRole("region", { name: "Server code" });
    await expect(serverCode).toContainText(
      "Added: it acts for whoever uses the App"
    );
    const makeCurrent = built.getByRole("button", {
      name: `Make version ${version} current`,
    });
    const again = serverCode.getByRole("button", {
      name: "Load the server code again",
    });
    await expect(again).toBeVisible();
    await expect(makeCurrent).toBeDisabled();
    failServerCode = false;
    await again.click();
    await serverCode.getByText("app/lib/format.ts, as it would run").click();
    await expect(
      serverCode
        .getByRole("figure")
        .filter({ hasText: "Would run after approval" })
    ).toContainText("export const format");
    await expect(makeCurrent).toBeEnabled();

    await makeCurrent.click();
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
