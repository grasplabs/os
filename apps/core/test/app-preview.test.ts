import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callApp } from "../src/app.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { workspace } from "../src/durable-objects.ts";
import { readStatistics } from "../src/statistics.ts";
import {
  pastAccessRecheck,
  release,
  requestGranted,
  serverBuilt,
} from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { collectionWithNote, readCollection } from "./knowledge.ts";
import { mailConnection } from "./mail-connection.ts";
import { auditedDuring, signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App: the draft's screens and server
// code, run for the chat's person with no side effects. These tests start
// from the ways it can fail: the draft's code writes to the App's real
// storage or Knowledge, calls a connection or another App, records a
// statistic, reaches the network, or reads real data it could show; a
// preview keeps what an earlier draft wrote; and someone other than the
// chat's person, or a person who no longer builds the App, previews it.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** Runs a promise and says how it ended, by error code; for App code. */
const outcomeCode = `export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "failed";
  }
};
`;

/**
 * The App's server code: it keeps notes in its storage. The draft's
 * (`tries`) also tries every binding its permissions give it.
 */
const serverCode = (
  tries: boolean
) => `import { DurableObject } from "cloudflare:workers";

import { outcome } from "./outcome.js";

type Caller = { userId: string; token: string };
const env = (self: DurableObject): Record<string, any> => (self as unknown as { env: Record<string, any> }).env;

export class App extends DurableObject {
  remember(_caller: Caller, note: string): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (note TEXT)");
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", note);
    return this.notes();
  }

  notes(): string[] {
    const found = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name = 'notes'")
      .toArray();
    if (found.length === 0) {
      return [];
    }
    return this.ctx.storage.sql.exec("SELECT note FROM notes").toArray().map((row) => String(row.note));
  }

  envNames(): string[] {
    return Object.keys(env(this)).toSorted();
  }

  tables(): string[] {
    return this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => String(row.name))
      .filter((name) => !name.startsWith("_cf") && !name.startsWith("sqlite"));
  }
${
  tries
    ? `
  async tries(caller: Caller, documentId: string): Promise<Record<string, unknown>> {
    const { MAIL, HANDBOOK, LEDGER, STATISTICS } = env(this);
    const listed = await HANDBOOK.listDocuments(caller);
    const found = await HANDBOOK.search(caller, "note");
    const records = await HANDBOOK.listRecords(caller);
    const stats = await STATISTICS.read(caller, { measure: "opened", days: 1, where: {} });
    return {
      mail: await outcome(MAIL.call(caller, "mail.send", { to: "ben@acme.test", subject: "Hi" }, { idempotencyKey: "k" })),
      listed: listed.documents.length,
      found: found.hits.length,
      records: records.records.length,
      read: await outcome(HANDBOOK.getDocument(caller, documentId)),
      section: await outcome(HANDBOOK.read(caller, documentId)),
      canWrite: await HANDBOOK.canWrite(caller),
      save: await outcome(HANDBOOK.saveRecord(caller, { path: "a.md", ifVersion: 0, record: {}, body: "" })),
      ledger: await outcome(LEDGER.call(caller, "book", {})),
      point: await outcome(STATISTICS.record(caller, { measure: "opened", value: 1 })),
      stats: stats.groups.length,
      fetch: await outcome(fetch("https://example.com/")),
    };
  }

  fail(): never {
    throw new Error("Invoice 7 has no total");
  }

  async kinds(caller: Caller): Promise<string[]> {
    const { MAIL, HANDBOOK, LEDGER, STATISTICS } = env(this);
    const said = async (call: () => Promise<unknown>): Promise<string> => {
      try {
        await call();
        return "ok";
      } catch (error) {
        return String((error as Error).message);
      }
    };
    return [
      await said(() => MAIL.listDocuments(caller)),
      await said(() => HANDBOOK.call(caller, "mail.send", {})),
      await said(() => LEDGER.record(caller, {})),
      await said(() => STATISTICS.getDocument(caller, "note")),
    ];
  }

  #watcher: ((value: number) => Promise<void>) | undefined;
  #pushed = 0;
  #stopped = "no";

  watch(_caller: Caller, onChange: { dup(): (value: number) => Promise<void> }): string {
    this.#watcher = onChange.dup();
    const push = async (): Promise<void> => {
      try {
        this.#pushed += 1;
        await this.#watcher?.(this.#pushed);
        setTimeout(push, 50);
      } catch (error) {
        this.#stopped = (error as { code?: string }).code ?? "failed";
      }
    };
    void push();
    return "watching";
  }

  stopped(): string {
    return this.#stopped;
  }

  async slow(_caller: Caller, entered: (value: string) => Promise<void>): Promise<string> {
    await entered("in");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return "done";
  }
`
    : ""
}}
`;

const screen = `export default function Desk() {
  return <main>Desk</main>;
}
`;

/** The App as released: notes in its storage, and a screen. */
const released = {
  "app/server.ts": serverCode(false),
  "app/outcome.ts": outcomeCode,
  "screens/desk.tsx": screen,
};

/** A new App of `builder`'s, released and built ahead. */
const newApp = async (
  builder: Person,
  name: string,
  files: Record<string, string>
): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name });
  await serverBuilt(id, await release(builder, id, files));
  return appIdSchema.parse(id);
};

/** The Workspace object that holds `person`'s chats. */
const chatsOf = (person: Person) =>
  workspace(env, personalWorkspaceId(person.userId));

/**
 * `person`'s new chat, with a draft of `app` over version 1 whose files
 * are `changes`, as the chat's agent writes one; returns its revision.
 */
const chatWithDraft = async (
  person: Person,
  app: AppId,
  changes: Record<string, string | null>
) => {
  const chat = await person.api.chats.create("Build");
  const chatId = chatIdSchema.parse(chat.id);
  const write = async (
    written: Record<string, string | null>,
    revision: number
  ) => {
    const saved = await chatsOf(person).saveDraft(
      chatId,
      app,
      1,
      written,
      [],
      revision
    );
    if (!saved) {
      throw new Error("The draft wasn't written");
    }
    return revision + 1;
  };
  return { chatId, revision: await write(changes, 0), write };
};

/**
 * An App with a mail connection (`MAIL`), a collection with a note
 * (`HANDBOOK`) and another App's exports (`LEDGER`), each granted by an
 * admin, and a draft of it in a chat of its builder's.
 */
const setUp = async () => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const app = await newApp(builder, "Invoice desk", released);
  const ledger = await newApp(admin, "Ledger", {
    "app/server.ts": `import { DurableObject } from "cloudflare:workers";\n\nexport class App extends DurableObject {\n  book(): string {\n    return "booked";\n  }\n}\n`,
    "app/exports.json": JSON.stringify({
      book: {
        access: "write",
        description: "Books an invoice",
        input: { type: "object" },
        output: { type: "string" },
      },
    }),
  });
  const mail = await mailConnection();
  const subject = { type: "app", appId: app } as const;
  await requestGranted(idp, admin, {
    subject,
    object: { type: "connection", connectionId: mail.id },
    actions: ["mail.send"],
    binding: "MAIL",
  });
  const { collectionId, noteId } = await collectionWithNote(admin.api, {
    name: "Handbook",
    access: "everyone",
  });
  await requestGranted(idp, admin, readCollection(subject, collectionId));
  await requestGranted(idp, admin, {
    subject,
    object: { type: "app", appId: ledger },
    actions: ["write"],
    binding: "LEDGER",
  });
  const draft = await chatWithDraft(builder, app, {
    "app/server.ts": serverCode(true),
  });
  return { admin, builder, app, mail, noteId, ...draft };
};

/** What a call answered, or the code of the error it failed with. */
const answer = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : String(error);
  }
};

describe("previewing a chat's draft", { timeout: 120_000 }, () => {
  it("runs the draft's screens and server code in a database of its own, dropped when the draft changes", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const call = async (at: number, method: string, args: unknown[] = []) =>
      await answer(chats.previewCall(chatId, app, at, method, args));
    const appNotes = async () =>
      await callApp(
        env,
        app,
        { userId: builder.userId, mode: "interactive" },
        "notes"
      );

    const bundle = await chats.preview(chatId, app);
    const first = {
      remembered: await call(revision, "remember", ["draft"]),
      // Its database is its own: none of the chats kept next to it.
      tables: await call(revision, "tables"),
      // The App's own storage has none of it.
      appNotes: await appNotes(),
    };
    // A restart of the object that holds the chat starts it afresh.
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    const restarted = await call(revision, "notes");
    await call(revision, "remember", ["again"]);
    // A write drops the preview of the revision before: a call for it is
    // refused, and the new revision starts with an empty database.
    const next = await write({ "screens/list.tsx": screen }, revision);
    const changed = {
      earlier: await call(revision, "notes"),
      notes: await call(next, "notes"),
      bundle: await chats.preview(chatId, app, "list"),
      // An error of the draft's code comes back as an App's does.
      failed: await call(next, "fail"),
    };

    expect({
      bundle,
      modules: Object.keys(bundle.modules).length > 0,
      first,
      restarted,
      changed,
    }).toMatchObject({
      bundle: {
        app,
        name: "Invoice desk",
        revision,
        screen: "desk",
        screens: ["desk"],
      },
      modules: true,
      first: { remembered: ["draft"], tables: ["notes"], appNotes: [] },
      restarted: [],
      changed: {
        earlier: "app.preview_outdated",
        notes: [],
        bundle: { revision: next, screen: "list", screens: ["desk", "list"] },
        failed: "app.failed",
      },
    });
  });

  it("never writes, calls out or reads real data, under the names the App's permissions give", async () => {
    const { builder, app, mail, noteId, chatId, revision } = await setUp();
    const { chats } = builder.api;
    const asBuilder = {
      userId: builder.userId,
      mode: "interactive",
    } as const;

    const names = {
      preview: await chats.previewCall(chatId, app, revision, "envNames", []),
      app: await callApp(env, app, asBuilder, "envNames"),
    };
    let tried: unknown;
    const events = await auditedDuring(async () => {
      tried = await chats.previewCall(chatId, app, revision, "tries", [noteId]);
    });
    const stats = await readStatistics(
      env,
      {
        subject: { type: "app", appId: app },
        onBehalfOf: builder.userId,
        mode: "interactive",
        appVersion: 1,
      },
      { measure: "opened", days: 1, where: {} }
    );

    const refused = "app.preview_side_effect";
    expect({
      names,
      tried,
      // Nothing reached the mail server, nothing was held for the person,
      // no statistic was recorded, and nothing was audited: nothing
      // happened.
      mail: await mail.did(),
      held: await builder.api.pendingActions.list(),
      stats: stats.groups,
      events,
    }).toStrictEqual({
      names: {
        preview: ["HANDBOOK", "LEDGER", "MAIL", "STATISTICS"],
        app: ["HANDBOOK", "LEDGER", "MAIL", "STATISTICS"],
      },
      tried: {
        mail: refused,
        listed: 0,
        found: 0,
        records: 0,
        read: "knowledge.not_found",
        section: "knowledge.not_found",
        canWrite: false,
        save: refused,
        ledger: refused,
        point: "ok",
        stats: 0,
        fetch: "failed",
      },
      mail: { calls: 0, sent: [] },
      held: [],
      stats: [],
      events: [],
    });
  });

  it("is only for the chat's person, while they build the App and it's switched on", async () => {
    const { admin, builder, app, chatId, revision } = await setUp();
    const [stranger, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    await admin.api.apps.members.add(app, {
      type: "person",
      id: stranger.userId,
      role: "builder",
    });
    await admin.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const empty = await builder.api.chats.create("Nothing yet");
    const theirs = await chatWithDraft(user, app, { "notes.md": "theirs" });
    const both = async (
      person: Person,
      chat: string,
      at: number
    ): Promise<unknown[]> => [
      await answer(person.api.chats.preview(chat, app)),
      await answer(person.api.chats.previewCall(chat, app, at, "notes", [])),
    ];

    const refusals = {
      // Someone else's chat is no chat of theirs, whatever their role.
      strangers: await both(stranger, chatId, revision),
      // A chat with no draft of the App has nothing to preview.
      empty: await both(builder, empty.id, 1),
      // Someone who only uses the App: not even a draft in their own chat.
      user: await both(user, theirs.chatId, theirs.revision),
    };
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    let off: unknown[];
    try {
      env.FEATURES = { ...on, app_preview: false };
      off = await both(builder, chatId, revision);
    } finally {
      env.FEATURES = features;
    }

    expect({ ...refusals, off }).toStrictEqual({
      strangers: ["agent.chat_not_found", "agent.chat_not_found"],
      empty: ["app.no_draft", "app.no_draft"],
      user: ["role.forbidden", "role.forbidden"],
      off: ["feature.disabled", "feature.disabled"],
    });
  });

  it("gives each binding exactly its real binding's methods, so a wrong call fails as it would live", async () => {
    const { builder, app, chatId, revision } = await setUp();
    // The same code as the App's own: the live answers to compare with.
    await serverBuilt(
      app,
      await release(builder, app, { "app/server.ts": serverCode(true) })
    );

    const preview = await builder.api.chats.previewCall(
      chatId,
      app,
      revision,
      "kinds",
      []
    );
    const live = await callApp(
      env,
      app,
      { userId: builder.userId, mode: "interactive" },
      "kinds"
    );
    expect({ preview, live }).toStrictEqual({
      preview: live,
      live: [
        expect.stringContaining("listDocuments"),
        expect.stringContaining("call"),
        expect.stringContaining("record"),
        expect.stringContaining("getDocument"),
      ],
    });
  });

  it("answers a call the draft's next write stops as out of date, not as the draft's failure", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const entered = Promise.withResolvers<boolean>();

    const slow = answer(
      chats.previewCall(chatId, app, revision, "slow", [
        () => {
          entered.resolve(true);
        },
      ])
    );
    await entered.promise;
    await write({ "screens/list.tsx": screen }, revision);

    await expect(slow).resolves.toBe("app.preview_outdated");
  });

  it("stops a preview's callbacks once their person no longer builds the App, or previews are off", async () => {
    const { admin, app } = await setUp();
    const other = await signedInApi(idp, "builder");
    const role = async (member: "builder" | "user") => {
      await admin.api.apps.members.add(app, {
        type: "person",
        id: other.userId,
        role: member,
      });
    };
    await role("builder");
    const { chats } = other.api;

    /** Watches pushes in a chat of theirs, then takes away what `lose` does. */
    const stopsWhen = async (
      lose: () => Promise<void>,
      restore: () => Promise<void>
    ) => {
      const draft = await chatWithDraft(other, app, {
        "app/server.ts": serverCode(true),
      });
      const received: unknown[] = [];
      await chats.previewCall(draft.chatId, app, draft.revision, "watch", [
        (value: unknown) => {
          received.push(value);
        },
      ]);
      await vi.waitFor(() => {
        expect(received.length).toBeGreaterThan(1);
      });
      await lose();
      // Past the time one answer holds: the next push checks again, and is
      // refused, and every one after.
      await pastAccessRecheck(async () => {
        await vi.waitFor(
          async () => {
            const before = received.length;
            await scheduler.wait(300);
            expect(received).toHaveLength(before);
          },
          { timeout: 5000, interval: 0 }
        );
      });
      await restore();
      const stopped = await chats.previewCall(
        draft.chatId,
        app,
        draft.revision,
        "stopped",
        []
      );
      return stopped;
    };

    const unshared = await stopsWhen(
      async () => {
        await role("user");
      },
      async () => {
        await role("builder");
      }
    );
    const on = z.record(z.string(), z.boolean()).parse(env.FEATURES);
    const { FEATURES: features } = env;
    const switchedOff = await stopsWhen(
      async () => {
        await Promise.resolve();
        env.FEATURES = { ...on, app_preview: false };
      },
      async () => {
        await Promise.resolve();
        env.FEATURES = features;
      }
    ).finally(() => {
      env.FEATURES = features;
    });

    // Each push was refused by core, as a screen's is once its person may
    // no longer use the App.
    expect({ unshared, switchedOff }).toStrictEqual({
      unshared: "app.not_found",
      switchedOff: "app.not_found",
    });
  });
});
