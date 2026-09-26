/**
 * The Microsoft 365 connector against a real test tenant: skipped unless
 * the environment names one. It runs connect's whole call path (policy, a
 * fresh isolate, the egress with its allowlist and SharePoint download
 * redirect) against Graph itself, with a token taken as is.
 *
 * To run it, get a delegated Graph access token for a test tenant's user,
 * with the connector's scopes (User.Read, Mail.ReadWrite,
 * Mail.ReadWrite.Shared, Mail.Send, Mail.Send.Shared, Calendars.Read,
 * Calendars.Read.Shared, Files.Read.All, Sites.Read.All; Graph Explorer
 * gives one), then, from the repo root:
 *
 *   M365_SMOKE_ACCESS_TOKEN=<token> \
 *   M365_SMOKE_MAILBOX=<a mailbox the user may read, e.g. a shared one> \
 *   M365_SMOKE_DRIVE=<a drive with a file at its top: its ID, from
 *     GET /me/drive or GET /sites/{site}/drive> \
 *   vp test run --project @grasp-os/connect test/microsoft-365.live.test.ts
 *
 * Add M365_SMOKE_WRITES=1 to also create a draft in the mailbox, try to
 * move it to a folder of another mailbox (refused), and move it to Deleted
 * Items. M365_SMOKE_FOREIGN_FOLDER names that other folder: say, the
 * user's own Inbox's ID (GET /me/mailFolders/inbox) when M365_SMOKE_MAILBOX
 * is a shared mailbox. Never point it at a client's tenant.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { outcome } from "./connect.ts";
import { smokeConnection, smokeRun as run } from "./smoke.ts";

const smoke = z
  .object({
    M365_SMOKE_ACCESS_TOKEN: z.string().min(1),
    M365_SMOKE_MAILBOX: z.string().min(1),
    M365_SMOKE_DRIVE: z.string().min(1),
    M365_SMOKE_WRITES: z.literal("1").optional(),
    M365_SMOKE_FOREIGN_FOLDER: z.string().min(1).optional(),
  })
  .safeParse(env);

describe.runIf(smoke.success)("Microsoft 365, live", () => {
  const config = smoke.data;
  /** A shared connection holding the token, as OAuth would leave one. */
  const connection = async (): Promise<string> =>
    await smokeConnection(
      "microsoft",
      "microsoft-365",
      config?.M365_SMOKE_ACCESS_TOKEN ?? ""
    );

  it("reads mail, a calendar and files, and pages through mail", async () => {
    const id = await connection();
    const mailbox = config?.M365_SMOKE_MAILBOX ?? "";
    const drive = config?.M365_SMOKE_DRIVE ?? "";
    const mail = await run(id, "mail.list", { mailbox, top: 2 }, mailbox);
    expect(mail.mailbox).toBe(mailbox);
    if (typeof mail.nextPage === "string") {
      await run(
        id,
        "mail.list",
        { mailbox, top: 2, page: mail.nextPage },
        mailbox
      );
    }
    const now = Date.now();
    await run(
      id,
      "calendar.list",
      {
        mailbox,
        start: new Date(now).toISOString(),
        end: new Date(now + 7 * 24 * 3600 * 1000).toISOString(),
      },
      mailbox
    );
    const files = z
      .object({
        items: z.array(z.object({ id: z.string(), kind: z.string() })),
      })
      .parse(await run(id, "files.list", { drive }, drive));
    // The drive's top folder must hold a file: it is read through Graph's
    // redirect to SharePoint.
    const item = files.items.find(({ kind }) => kind === "file")?.id ?? "";
    await expect(
      run(id, "files.read", { drive, item, as: "base64" }, drive)
    ).resolves.toMatchObject({ id: item, encoding: "base64" });
  });

  it.runIf(config?.M365_SMOKE_WRITES === "1")(
    "creates a draft, and moves it to Deleted Items but not another mailbox",
    async () => {
      const id = await connection();
      const mailbox = config?.M365_SMOKE_MAILBOX ?? "";
      const key = crypto.randomUUID();
      const draft = await run(
        id,
        "mail.createDraft",
        {
          mailbox,
          subject: "Grasp OS smoke test",
          body: "Created and removed by the connector's smoke test.",
          to: [mailbox],
        },
        mailbox,
        `${key}:draft`
      );
      const foreign =
        config?.M365_SMOKE_FOREIGN_FOLDER ?? "AAMkAGNoSuchFolderInThisMailbox=";
      await expect(
        outcome(
          run(
            id,
            "mail.move",
            { mailbox, message: String(draft.id), destination: foreign },
            mailbox,
            `${key}:move-away`
          )
        )
      ).resolves.toBe("connect.action_failed");
      // Still where it was: the move below starts from the same ID.
      await expect(
        run(
          id,
          "mail.move",
          { mailbox, message: String(draft.id), destination: "deleteditems" },
          mailbox,
          `${key}:move`
        )
      ).resolves.toMatchObject({ mailbox, previousId: draft.id });
    }
  );
});
