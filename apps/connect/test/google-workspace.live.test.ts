/**
 * The Google Workspace connector against a real test workspace: skipped
 * unless the environment names one. It runs connect's whole call path
 * (policy, a fresh isolate, the egress with its allowlist) against Google
 * itself, with a token taken as is.
 *
 * To run it, get an access token for a test workspace's user with the
 * connector's scopes (gmail.modify, calendar.events.readonly,
 * drive.readonly; the OAuth 2.0 Playground gives one), then, from the
 * repo root:
 *
 *   GOOGLE_SMOKE_ACCESS_TOKEN=<token> \
 *   GOOGLE_SMOKE_MAILBOX=<the user's address> \
 *   GOOGLE_SMOKE_DRIVE=<a shared drive with a file at its top: its ID,
 *     from GET https://www.googleapis.com/drive/v3/drives> \
 *   vp test run --project @grasp-os/connect test/google-workspace.live.test.ts
 *
 * GOOGLE_SMOKE_CALENDAR names a calendar other than the user's own. Add
 * GOOGLE_SMOKE_WRITES=1 to also create a draft in the mailbox, and star
 * and unstar it. Never point it at a client's workspace.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { smokeConnection, smokeRun as run } from "./smoke.ts";

const smoke = z
  .object({
    GOOGLE_SMOKE_ACCESS_TOKEN: z.string().min(1),
    GOOGLE_SMOKE_MAILBOX: z.string().min(1),
    GOOGLE_SMOKE_DRIVE: z.string().min(1),
    GOOGLE_SMOKE_CALENDAR: z.string().min(1).optional(),
    GOOGLE_SMOKE_WRITES: z.literal("1").optional(),
  })
  .safeParse(env);

describe.runIf(smoke.success)("Google Workspace, live", () => {
  const config = smoke.data;
  const mailbox = config?.GOOGLE_SMOKE_MAILBOX ?? "";

  /** A shared connection holding the token, as OAuth would leave one. */
  const connection = async (): Promise<string> =>
    await smokeConnection(
      "google",
      "google-workspace",
      config?.GOOGLE_SMOKE_ACCESS_TOKEN ?? ""
    );

  it("reads mail, a calendar and a shared drive, and pages through mail", async () => {
    const id = await connection();
    const drive = config?.GOOGLE_SMOKE_DRIVE ?? "";
    const calendar = config?.GOOGLE_SMOKE_CALENDAR ?? mailbox;
    const mail = z
      .object({
        mailbox: z.string(),
        messages: z.array(z.object({ id: z.string() })),
        nextPage: z.string().nullable(),
      })
      .parse(await run(id, "mail.list", { mailbox, top: 2 }, mailbox));
    expect(mail.mailbox).toBe(mailbox);
    if (mail.nextPage !== null) {
      await run(
        id,
        "mail.list",
        { mailbox, top: 2, page: mail.nextPage },
        mailbox
      );
    }
    const [first] = mail.messages;
    if (first !== undefined) {
      await run(id, "mail.get", { mailbox, message: first.id }, mailbox);
    }
    const now = Date.now();
    await run(
      id,
      "calendar.list",
      {
        calendar,
        start: new Date(now).toISOString(),
        end: new Date(now + 7 * 24 * 3600 * 1000).toISOString(),
      },
      calendar
    );
    const files = z
      .object({
        items: z.array(z.object({ id: z.string(), kind: z.string() })),
      })
      .parse(await run(id, "files.list", { drive }, drive));
    // The drive's top folder must hold a file (its own, or a Google Doc).
    const item = files.items.find(({ kind }) => kind === "file")?.id ?? "";
    await expect(
      run(id, "files.read", { drive, item, as: "base64" }, drive)
    ).resolves.toMatchObject({ id: item, encoding: "base64" });
  });

  it.runIf(config?.GOOGLE_SMOKE_WRITES === "1")(
    "creates a draft, and stars and unstars it",
    async () => {
      const id = await connection();
      const key = crypto.randomUUID();
      const draft = z.object({ messageId: z.string() }).parse(
        await run(
          id,
          "mail.createDraft",
          {
            mailbox,
            subject: "Grasp OS smoke test",
            body: "Created by the connector's smoke test.",
            to: [mailbox],
          },
          mailbox,
          `${key}:draft`
        )
      );
      const message = { mailbox, message: draft.messageId };
      const starred = z
        .object({ labelIds: z.array(z.string()) })
        .parse(
          await run(
            id,
            "mail.label",
            { ...message, add: ["STARRED"] },
            mailbox,
            `${key}:star`
          )
        );
      expect(starred.labelIds).toContain("STARRED");
      await run(
        id,
        "mail.label",
        { ...message, remove: ["STARRED"] },
        mailbox,
        `${key}:unstar`
      );
    }
  );
});
