import { workspaceIdSchema } from "@grasp-os/shared/ids";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { migrateOnWake } from "../src/db/migrate.ts";
import type { Migrations } from "../src/db/migrate.ts";
import migrations from "../src/db/workspace/migrations/migrations.js";
import { workspace } from "../src/durable-objects.ts";

const newWorkspace = () =>
  workspace(env, workspaceIdSchema.parse(crypto.randomUUID()));

/** The migrations the previous release shipped: all but the newest. */
const previousRelease: Migrations = {
  journal: { entries: migrations.journal.entries.slice(0, -1) },
  migrations: migrations.migrations,
};

/** A release that adds one migration after this release's. */
const withMigration = (tag: string, sql: string, idx?: number): Migrations => {
  const next = idx ?? migrations.journal.entries.length;
  return {
    journal: { entries: [...migrations.journal.entries, { idx: next, tag }] },
    migrations: {
      ...migrations.migrations,
      [`m${String(next).padStart(4, "0")}`]: sql,
    },
  };
};

/** A release after this one, which adds a column the code doesn't know yet. */
const nextRelease = (): Migrations =>
  withMigration(
    "next_release",
    "ALTER TABLE `chats` ADD `pinned` integer DEFAULT 0 NOT NULL;"
  );

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
    migrateOnWake(state, release);
  });
  await evictDurableObject(stub);
};

describe("Workspace schema", () => {
  it("migrates a fresh workspace before its first call", async () => {
    const chat = await newWorkspace().createChat(
      "Plans",
      "person-1",
      "agent-1"
    );
    expect(chat).toMatchObject({ title: "Plans" });
  });

  it("migrates a workspace on the previous release's schema when it wakes up", async () => {
    const stub = newWorkspace();
    await migrateTo(stub, previousRelease, { fromScratch: true });

    const chat = await stub.createChat("Plans", "person-1", "agent-1");
    expect(chat).toMatchObject({ title: "Plans" });
  });

  it("keeps chats that have a person and an agent, and drops those without, with their rows, when chats take both for good", async () => {
    const stub = newWorkspace();
    // The schema as it was before chats had to have both.
    const before = migrations.journal.entries.findIndex(
      ({ tag }) => tag === "0007_chat_owner_required"
    );
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      migrateOnWake(state, {
        journal: { entries: migrations.journal.entries.slice(0, before) },
        migrations: migrations.migrations,
      });
      for (const statement of [
        "INSERT INTO chats (id, title, created_at, restricted, person_id, agent_id) VALUES ('owned', 'Owned', 1, 1, 'person-1', 'agent-1'), ('nobodys', 'Nobody', 2, 0, NULL, NULL), ('no-agent', 'No agent', 3, 0, 'person-1', NULL)",
        "INSERT INTO chat_messages (chat_id, message, created_at) VALUES ('owned', '{\"n\":1}', 1), ('nobodys', '{}', 2), ('owned', '{\"n\":2}', 3), ('no-agent', '{}', 4)",
        "INSERT INTO chat_sources (chat_id, source_id, created_at) VALUES ('owned', 'collection-1', 1), ('nobodys', 'collection-1', 1), ('no-agent', 'collection-2', 1)",
        "INSERT INTO chat_drafts (chat_id, app_id, base, revision, updated_at) VALUES ('owned', 'app-1', NULL, 1, 1), ('no-agent', 'app-1', NULL, 1, 1)",
        "INSERT INTO chat_draft_files (chat_id, app_id, path, content) VALUES ('owned', 'app-1', 'index.ts', 'a'), ('no-agent', 'app-1', 'index.ts', 'b')",
        "INSERT INTO chat_attachments (chat_id, run_id, report, created_at) VALUES ('owned', 'run-1', '{}', 1), ('nobodys', 'run-2', '{}', 1)",
      ]) {
        state.storage.sql.exec(statement);
      }
    });
    await evictDurableObject(stub);

    // Waking up on this release's code applies the migration.
    const added = await stub.createChat("After", "person-1", "agent-1");
    await runInDurableObject(stub, (_instance, state) => {
      const rows = (query: string, ...bindings: string[]) =>
        state.storage.sql.exec(query, ...bindings).toArray();
      expect({
        chats: rows(
          "SELECT id, title, restricted, person_id AS personId, agent_id AS agentId FROM chats WHERE id <> ? ORDER BY id",
          added.id
        ),
        messages: rows(
          "SELECT chat_id AS chatId, message FROM chat_messages ORDER BY id"
        ),
        sources: rows("SELECT chat_id AS chatId FROM chat_sources"),
        drafts: rows("SELECT chat_id AS chatId FROM chat_drafts"),
        files: rows("SELECT chat_id AS chatId FROM chat_draft_files"),
        attachments: rows("SELECT chat_id AS chatId FROM chat_attachments"),
      }).toStrictEqual({
        chats: [
          {
            id: "owned",
            title: "Owned",
            restricted: 1,
            personId: "person-1",
            agentId: "agent-1",
          },
        ],
        messages: [
          { chatId: "owned", message: '{"n":1}' },
          { chatId: "owned", message: '{"n":2}' },
        ],
        sources: [{ chatId: "owned" }],
        drafts: [{ chatId: "owned" }],
        files: [{ chatId: "owned" }],
        attachments: [{ chatId: "owned" }],
      });
      // Its rows still refer to a chat that exists, and must.
      expect(() => {
        state.storage.transactionSync(() => {
          state.storage.sql.exec(
            "INSERT INTO chat_messages (chat_id, message, created_at) VALUES ('nobodys', '{}', 5)"
          );
        });
      }).toThrow(/FOREIGN KEY/u);
      expect(() => {
        state.storage.transactionSync(() => {
          state.storage.sql.exec(
            "INSERT INTO chats (id, title, created_at, person_id) VALUES ('half', 'Half', 6, 'person-1')"
          );
        });
      }).toThrow(/NOT NULL/u);
    });
  });

  it("keeps working when the code is rolled back after an additive migration", async () => {
    const stub = newWorkspace();
    const before = await stub.createChat(
      "Before the release",
      "person-1",
      "agent-1"
    );
    await migrateTo(stub, nextRelease(), { fromScratch: false });

    // Waking up again on this release's code leaves the newer schema alone.
    const after = await stub.createChat(
      "After the rollback",
      "person-1",
      "agent-1"
    );
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

  it("rolls back a failing migration and reports its error", async () => {
    const stub = newWorkspace();
    await stub.createChat("Before the release", "person-1", "agent-1");
    const broken = withMigration(
      "broken",
      "ALTER TABLE `chats` ADD `pinned` integer;\n--> statement-breakpoint\nALTER TABLE `missing` ADD `x` integer;"
    );

    await runInDurableObject(stub, (_instance, state) => {
      expect(() => {
        migrateOnWake(state, broken);
      }).toThrow(/no such table: missing/u);
      // Nothing of the failed migration stays, not even its first statement.
      const columns = state.storage.sql
        .exec("SELECT name FROM pragma_table_info('chats')")
        .toArray()
        .map(({ name }) => name);
      expect(columns).not.toContain("pinned");
    });
    const after = await stub.createChat(
      "After the failure",
      "person-1",
      "agent-1"
    );
    expect(after).toMatchObject({ title: "After the failure" });
  });

  it("refuses a migration history that doesn't match the code", async () => {
    const stub = newWorkspace();
    await migrateTo(stub, withMigration("ours", "SELECT 1;"), {
      fromScratch: false,
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(() => {
        migrateOnWake(state, withMigration("theirs", "SELECT 1;"));
      }).toThrow(/applied as ours/u);
    });
  });

  it("refuses a migration that comes before one already applied", async () => {
    const stub = newWorkspace();
    const next = migrations.journal.entries.length;
    await migrateTo(stub, withMigration("later", "SELECT 1;", next + 1), {
      fromScratch: false,
    });

    await runInDurableObject(stub, (_instance, state) => {
      expect(() => {
        migrateOnWake(state, withMigration("earlier", "SELECT 1;", next));
      }).toThrow(/comes before/u);
    });
  });
});
