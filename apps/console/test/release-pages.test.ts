import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { consoleDatabase } from "../src/db/act.ts";
import { importReleases } from "../src/releases/import.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { publishRelease } from "./releases.ts";
import type { TestRelease } from "./releases.ts";

mockAccess();

const origin = "https://console.grasp.test";

/** The page at `path`, as a staff member sees it. */
const page = async (path: string) => {
  const response = await exports.default.fetch(`${origin}${path}`, {
    headers: {
      "cf-access-jwt-assertion": await accessJwt("staff@grasp.test"),
    },
  });
  return { status: response.status, html: await response.text() };
};

// React escapes text, so compare with it escaped the same way.
const escaped = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

describe("the release pages", () => {
  let first: TestRelease;
  let second: TestRelease;
  let third: TestRelease;

  beforeAll(async () => {
    const token = crypto.randomUUID();
    first = await publishRelease({
      notes: `feat(core): first ${token}`,
      migrations: { "0000_init.sql": `-- ${token}\nCREATE TABLE a (id TEXT);` },
      assets: { "/index.html": `<html>${token}</html>` },
    });
    second = await publishRelease({
      notes: `feat(core): second ${token}`,
      migrations: {
        "0000_init.sql": `-- ${token}\nCREATE TABLE a (id TEXT);`,
        "0001_more.sql": `-- ${token}\nCREATE TABLE b (id TEXT);`,
      },
      assets: { "/index.html": `<html>${token} two</html>` },
    });
    third = await publishRelease({
      notes: `fix(connect): third ${token}`,
      connect: `export default { token: "${token}" };`,
      migrations: {
        "0000_init.sql": `-- ${token}\nCREATE TABLE a (id TEXT);`,
        "0001_more.sql": `-- ${token}\nCREATE TABLE b (id TEXT);`,
      },
      assets: {
        "/index.html": `<html>${token} two</html>`,
        "/app.js": `console.info("${token}");`,
      },
      packages: { zod: "4.1.0" },
      crons: ["*/15 * * * *"],
    });
    await importReleases(env.RELEASES, consoleDatabase(env.DB));
  });

  it("list every imported release with its note, newest first", async () => {
    const { status, html } = await page("/releases");

    expect(status).toBe(200);
    const positions = [third, second, first].map((release) =>
      html.indexOf(release.id)
    );
    expect(positions.every((position) => position >= 0)).toBeTruthy();
    expect(positions).toStrictEqual(positions.toSorted((a, b) => a - b));
    expect(html).toContain(escaped(second.manifest.notes));
  });

  it("show a release's Workers, modules and migrations", async () => {
    const { status, html } = await page(`/releases/${second.id}`);

    expect(status).toBe(200);
    for (const text of [
      second.manifest.notes,
      second.manifest.commit,
      "grasp-os-core",
      "grasp-os-connect",
      "index.js",
      "0001_more.sql",
    ]) {
      expect(html).toContain(escaped(text));
    }
  });

  it("show what changed between two releases, with the notes in between", async () => {
    const { status, html } = await page(
      `/releases/diff?from=${first.id}&to=${third.id}`
    );

    expect(status).toBe(200);
    // The rendered notes, not the page data sent along for hydration.
    const notes = html.slice(
      html.indexOf("Release notes"),
      html.indexOf("Compatibility date and packages")
    );
    expect(notes).toContain(escaped(second.manifest.notes));
    expect(notes).toContain(escaped(third.manifest.notes));
    expect(notes).not.toContain(escaped(first.manifest.notes));
    for (const change of [
      "DB/0001_more.sql",
      "/app.js",
      "/index.html",
      "cron */15 * * * *",
      "cron * * * * *",
      "4.0.0 to 4.1.0",
    ]) {
      expect(html).toContain(escaped(change));
    }
  });

  it("answer 404 for a release that isn't imported, or isn't a release id", async () => {
    const statuses = await Promise.all(
      [
        "/releases/r000000-0000000",
        "/releases/not-a-release",
        `/releases/diff?from=${first.id}&to=r000000-0000000`,
        "/releases/diff?from=..&to=x",
      ].map(async (path) => {
        const { status } = await page(path);
        return status;
      })
    );

    expect(statuses).toStrictEqual([404, 404, 404, 404]);
  });
});
