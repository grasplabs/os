import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { migrateOnWake } from "../src/db/migrate.ts";
import type { Migrations } from "../src/db/migrate.ts";
import migrations from "../src/db/workspace/migrations/migrations.js";
import { workspace } from "../src/workspace.ts";

const newWorkspace = () =>
  workspace(env, workspaceIdSchema.parse(crypto.randomUUID()));

/** The migrations the previous release shipped: all but the newest. */
const previousRelease: Migrations = {
  journal: { entries: migrations.journal.entries.slice(0, -1) },
  migrations: migrations.migrations,
};

/** A release after this one, which adds a column the code doesn't know yet. */
const nextRelease = (): Migrations => {
  const last = migrations.journal.entries.at(-1);
  const idx = (last?.idx ?? -1) + 1;
  return {
    journal: {
      entries: [
        ...migrations.journal.entries,
        {
          idx,
          when: (last?.when ?? 0) + 1,
          tag: "next_release",
          breakpoints: true,
        },
      ],
    },
    migrations: {
      ...migrations.migrations,
      [`m${String(idx).padStart(4, "0")}`]:
        "ALTER TABLE `chats` ADD `pinned` integer DEFAULT 0 NOT NULL;",
    },
  };
};

/** Replaces the object's storage with what `release` would have left. */
const migrateTo = async (
  stub: ReturnType<typeof newWorkspace>,
  release: Migrations,
  { fromScratch }: { fromScratch: boolean }
) => {
  await runInDurableObject(stub, async (_instance, state) => {
    if (fromScratch) {
      await state.storage.deleteAll();
    }
    await migrateOnWake(state, release);
  });
  await evictDurableObject(stub);
};

describe("Workspace schema", () => {
  it("migrates a fresh workspace before its first call", async () => {
    const chat = await newWorkspace().createChat("Plans");
    expect(chat).toMatchObject({ title: "Plans" });
  });

  it("migrates a workspace on the previous release's schema when it wakes up", async () => {
    const stub = newWorkspace();
    await migrateTo(stub, previousRelease, { fromScratch: true });

    const chat = await stub.createChat("Plans");
    expect(chat).toMatchObject({ title: "Plans" });
  });

  it("keeps working when the code is rolled back after an additive migration", async () => {
    const stub = newWorkspace();
    const before = await stub.createChat("Before the release");
    await migrateTo(stub, nextRelease(), { fromScratch: false });

    // Waking up again on this release's code leaves the newer schema alone.
    const after = await stub.createChat("After the rollback");
    expect(after).toMatchObject({ title: "After the rollback" });
    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec("SELECT title, pinned FROM chats ORDER BY rowid")
        .toArray();
      expect(rows).toStrictEqual([
        { title: before.title, pinned: 0 },
        { title: after.title, pinned: 0 },
      ]);
    });
  });
});
