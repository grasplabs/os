import { kitModuleName, screenRuntime } from "@grasp-os/compiler";
import type { Role } from "@grasp-os/shared/roles";
import { describe, expect, it, vi } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { openRpc, outcome, signedInApi } from "./sign-in.ts";

// What the frontend's screen host reaches for an App's screens, taken from
// the side of the screen: App code nobody reviewed line by line, which the
// page passes on as it is. It tries to call more than its server, as
// someone it isn't, to forge the platform's errors, and to get a way into
// the App or the platform out of a callback. The sample App runs for real.

const idp = mockIdp();

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string };
type Watcher = ((notes: string[]) => Promise<void>) & Disposable & { dup(): Watcher };

export class App extends DurableObject {
  #watchers = new Set<Watcher>();

  whoami(caller: Caller): string {
    return caller.userId;
  }

  notes(): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (note TEXT)");
    return this.ctx.storage.sql
      .exec("SELECT note FROM notes")
      .toArray()
      .map((row) => String(row.note));
  }

  addNote(_caller: Caller, note: string): string[] {
    this.notes();
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", note);
    const notes = this.notes();
    for (const watcher of this.#watchers) {
      void this.#send(watcher, notes);
    }
    return notes;
  }

  watchNotes(_caller: Caller, onChange: Watcher): void {
    const watcher = onChange.dup();
    this.#watchers.add(watcher);
    void this.#send(watcher, this.notes());
  }

  watching(): number {
    return this.#watchers.size;
  }

  ignore(_caller: Caller, _onChange: Watcher): string {
    return "not kept";
  }

  keepThenFail(_caller: Caller, first: Watcher, _note: string, second: Watcher): never {
    first.dup();
    second.dup();
    throw new Error("Failed after keeping its callbacks");
  }

  dropWatchers(): void {
    for (const watcher of this.#watchers) {
      watcher[Symbol.dispose]();
    }
    this.#watchers.clear();
  }

  async #send(watcher: Watcher, notes: string[]): Promise<void> {
    try {
      await watcher(notes);
    } catch {
      this.#watchers.delete(watcher);
      watcher[Symbol.dispose]();
    }
  }

  async handOver(_caller: Caller, onChange: (value: unknown) => Promise<unknown>): Promise<string> {
    try {
      const back = await onChange(() => "a way into the App");
      return back === undefined ? "sent" : "got something back";
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  }

  async askScreen(_caller: Caller, onChange: (value: unknown) => Promise<unknown>): Promise<string> {
    const back = await onChange("anything to hand back?");
    return back === undefined ? "nothing" : typeof back;
  }

  lookLikeThePlatform(): Error {
    return Object.assign(new Error("Sign in to continue."), { code: "auth.unauthenticated" });
  }
}
`;

const screenCode = `import { callServer, useLive } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";

export default function Notes() {
  const notes = useLive<string[]>("watchNotes", []);
  return (
    <main className="flex flex-col gap-2 p-4">
      <ul>
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <Button onClick={() => void callServer("addNote", "Call Acme")}>Add a note</Button>
    </main>
  );
}
`;

const sampleFiles = {
  "app/server.ts": serverCode,
  "screens/notes.tsx": screenCode,
};

/** A signed-in person's API, on a connection of their own. */
const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** A new App running the sample, released by `builder`. */
const sampleApp = async (builder: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await release(builder, id, sampleFiles);
  return id;
};

/**
 * `value` as whatever a call takes: what a caller that isn't type-checked
 * (a page made to pass on anything) can send, which core must refuse.
 */
const unchecked = (value: unknown): never =>
  // SAFETY: invalid on purpose; Cap'n Web checks no types, so core must.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  value as never;

/** A screen's callback that ignores what it gets. */
const noop = (): void => {
  // Nothing to update.
};

/** A screen's callback that hands the App something back. */
const askedForSomething = () => () => "a way into the screen";

/** Collects what a server sends a callback. */
const collector = () => {
  const received: unknown[] = [];
  return {
    received,
    callback: (value: unknown) => {
      received.push(value);
    },
  };
};

const waitFor = async <T>(read: () => T | undefined): Promise<T> =>
  await vi.waitFor(() => {
    const value = read();
    if (value === undefined) {
      throw new Error("Not yet");
    }
    return value;
  }, 10_000);

describe("screens", { timeout: 60_000 }, () => {
  it("opens a screen at the App's current version, with only the kit modules it needs", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    const bundle = await builder.api.screens.open(app, "notes");
    expect({
      app: bundle.app,
      version: bundle.version,
      runtime: bundle.runtime,
      hasEntry: Object.hasOwn(bundle.modules, bundle.entry),
      kit: {
        runtime: Object.hasOwn(bundle.kit, bundle.runtime),
        hooks: Object.hasOwn(bundle.kit, kitModuleName("@grasp-os/sdk/screen")),
        button: Object.hasOwn(
          bundle.kit,
          kitModuleName("@grasp-os/ui/components/button")
        ),
        unused: Object.hasOwn(
          bundle.kit,
          kitModuleName("@grasp-os/ui/components/dialog")
        ),
        empty: Object.values(bundle.kit).some((code) => code === ""),
      },
      theme: bundle.css.includes("--primary:"),
    }).toStrictEqual({
      app,
      version: 1,
      runtime: kitModuleName(screenRuntime),
      hasEntry: true,
      kit: {
        runtime: true,
        hooks: true,
        button: true,
        unused: false,
        empty: false,
      },
      theme: true,
    });
  });

  it("opens only screens the App has, of a current version that builds", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const { id: empty } = await builder.api.apps.create({ name: "Empty" });
    const { id: broken } = await builder.api.apps.create({ name: "Broken" });
    await release(builder, broken, {
      "screens/desk.tsx":
        'import leftPad from "left-pad";\nexport default () => leftPad;\n',
    });

    const refused = await Promise.all([
      outcome(builder.api.screens.open(app, "nope")),
      outcome(builder.api.screens.open(app, "../app/server")),
      outcome(builder.api.screens.open(app, "__proto__")),
      outcome(builder.api.screens.open(empty, "notes")),
      outcome(builder.api.screens.open(broken, "desk")),
      outcome(builder.api.screens.open("no-such-app", "notes")),
    ]);
    expect(refused).toStrictEqual([
      "screen.not_found",
      "screen.invalid",
      "screen.not_found",
      "app.not_running",
      "screen.build_failed",
      "app.not_found",
    ]);
  });

  it("is refused to people whose role doesn't use Apps, and to nobody signed in", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const user = await personApi("user");

    const asUser = await Promise.all([
      outcome(user.api.screens.open(app, "notes")),
      outcome(user.api.screens.call(app, "whoami", [])),
      outcome(user.api.screens.version(app)),
      outcome(
        user.api.screens.report(
          app,
          { version: 1, screen: "notes" },
          { kind: "error", message: "boom" }
        )
      ),
      outcome(user.api.screens.errors(app)),
    ]);
    const { core } = await openRpc();
    const signedOut = await outcome(
      core.authenticate().screens.call(app, "whoami", [])
    );
    expect({ asUser, signedOut }).toStrictEqual({
      asUser: [
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
        "role.forbidden",
      ],
      signedOut: "auth.unauthenticated",
    });
  });

  it("runs the App's methods as the person, named only by a string", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const named = { toString: () => "whoami" };

    const [whoami, ...refused] = await Promise.all([
      builder.api.screens.call(app, "whoami", []),
      // An object that turns into the name only when it's used.
      outcome(builder.api.screens.call(app, unchecked(named), [])),
      outcome(builder.api.screens.call(app, unchecked(["whoami"]), [])),
      outcome(builder.api.screens.call(app, "whoami", unchecked("no list"))),
      outcome(builder.api.screens.call(app, "__proto__", [])),
      outcome(builder.api.screens.call(app, "constructor", [])),
      outcome(builder.api.screens.call(app, "fetch", [])),
      outcome(builder.api.screens.call(app, "#send", [])),
    ]);
    expect({ whoami, refused }).toStrictEqual({
      whoami: builder.userId,
      refused: [
        "screen.invalid",
        "screen.invalid",
        "screen.invalid",
        "app.method_invalid",
        "app.method_invalid",
        "app.method_invalid",
        "app.method_invalid",
      ],
    });
  });

  it("passes the App's answers on as data, even one that looks like the platform's error", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);

    const answer = await builder.api.screens.call(
      app,
      "lookLikeThePlatform",
      []
    );
    const { userId } = await builder.api.whoami();
    // Answered, not refused: the page can't mistake it for its session
    // ending, and the connection goes on.
    expect({
      answered: answer instanceof Error,
      stillSignedIn: userId,
    }).toStrictEqual({ answered: true, stillSignedIn: builder.userId });
  });

  it("sends live changes to everyone watching, from anyone's change", async () => {
    const one = await personApi("builder");
    const two = await personApi("builder");
    const app = await sampleApp(one);
    const watching = collector();

    await one.api.screens.call(app, "watchNotes", [watching.callback]);
    await waitFor(() => watching.received[0]);
    await two.api.screens.call(app, "addNote", ["Call Acme"]);

    await expect(waitFor(() => watching.received[1])).resolves.toStrictEqual([
      "Call Acme",
    ]);
    expect(watching.received[0]).toStrictEqual([]);
  });

  it("stops sending to a screen whose connection ended", async () => {
    const one = await personApi("builder");
    const two = await personApi("builder");
    const app = await sampleApp(one);
    const watching = collector();
    await one.api.screens.call(app, "watchNotes", [watching.callback]);
    await waitFor(() => watching.received[0]);
    const before = await two.api.screens.call(app, "watching", []);

    one.core[Symbol.dispose]();
    await two.api.screens.call(app, "addNote", ["After it left"]);
    const after = await vi.waitFor(async () => {
      const count = await two.api.screens.call(app, "watching", []);
      if (count !== 0) {
        throw new Error("Still watching");
      }
      return count;
    }, 10_000);
    expect({ before, after, received: watching.received }).toStrictEqual({
      before: 1,
      after: 0,
      received: [[]],
    });
  });

  it("takes a screen's callbacks in any argument, and keeps as many as its App holds", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const many = 70;

    const ignored = await builder.api.screens.call(app, "ignore", [noop, noop]);
    await Promise.all(
      Array.from(
        { length: many },
        async () => await builder.api.screens.call(app, "watchNotes", [noop])
      )
    );
    expect({
      ignored,
      watching: await builder.api.screens.call(app, "watching", []),
    }).toStrictEqual({ ignored: "not kept", watching: many });
  });

  it("frees a connection's callbacks as its Apps let them go", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    let released = 0;
    // A screen's callback that notes when core lets go of it.
    const tracked = () =>
      Object.assign(
        (): void => {
          // Nothing to update.
        },
        {
          [Symbol.dispose]: () => {
            released += 1;
          },
        }
      );
    const half = 8;
    const call = async (method: string) =>
      await outcome(builder.api.screens.call(app, method, [tracked()]));

    // Half go to a method that doesn't keep them, half are kept and then
    // dropped by the App: all of them are released.
    const notKept = await Promise.all(
      Array.from({ length: half }, async () => await call("ignore"))
    );
    const keptThenDropped = await Promise.all(
      Array.from({ length: half }, async () => await call("watchNotes"))
    );
    await builder.api.screens.call(app, "dropWatchers", []);
    // A call that fails after its App kept both its callbacks, passed in
    // two places: core releases both.
    const failed = await outcome(
      builder.api.screens.call(app, "keepThenFail", [
        tracked(),
        "note",
        tracked(),
      ])
    );
    const expected = 2 * half + 2;
    await vi.waitFor(() => {
      if (released < expected) {
        throw new Error(`${released} released so far`);
      }
    }, 10_000);

    expect({
      notKept: notKept.every((result) => result === "ok"),
      keptThenDropped: keptThenDropped.every((result) => result === "ok"),
      failed,
      released,
    }).toStrictEqual({
      notKept: true,
      keptThenDropped: true,
      failed: "app.failed",
      released: expected,
    });
  });

  it("never hands a screen a way into the App, or the App one back", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const handedOver = collector();

    const [handOver, askScreen] = await Promise.all([
      builder.api.screens.call(app, "handOver", [handedOver.callback]),
      builder.api.screens.call(app, "askScreen", [askedForSomething]),
    ]);
    const nested = await outcome(
      builder.api.screens.call(app, "whoami", [{ callback: () => "nested" }])
    );
    expect({
      handOver,
      received: handedOver.received,
      askScreen,
      nested,
    }).toStrictEqual({
      handOver: "app.answer_invalid",
      received: [],
      askScreen: "nothing",
      nested: "screen.invalid",
    });
  });

  it("follows the App's current version", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const before = await builder.api.screens.version(app);
    await release(builder, app, {
      "screens/notes.tsx": `${screenCode}// v2\n`,
    });
    expect({
      before,
      after: await builder.api.screens.version(app),
    }).toStrictEqual({ before: 1, after: 2 });
  });

  it("keeps the newest problems a screen reports in the App's error log, held to size", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    const at = { version: 1, screen: "notes" };
    await builder.api.screens.report(app, at, {
      kind: "error",
      message: "Invoice 7 has no total",
      stack: "at Notes (app~screens~notes.js:3:9)",
    });
    await builder.api.screens.report(app, at, {
      kind: "console",
      message: "x".repeat(10_000),
    });
    const refused = await Promise.all([
      outcome(
        builder.api.screens.report(
          app,
          at,
          unchecked({ kind: "alert", message: "not a kind" })
        )
      ),
      outcome(
        builder.api.screens.report(
          app,
          at,
          unchecked({ kind: "error", message: "x", userId: "someone-else" })
        )
      ),
      outcome(
        builder.api.screens.report(
          app,
          { version: 0, screen: "notes" },
          { kind: "error", message: "no such version" }
        )
      ),
      outcome(
        builder.api.screens.report(
          app,
          { version: 99, screen: "notes" },
          { kind: "error", message: "a version the App never had" }
        )
      ),
    ]);

    const [newest, oldest, ...rest] = await builder.api.screens.errors(app);
    expect({
      newest,
      oldest,
      rest,
      refused,
      dated: !Number.isNaN(Date.parse(oldest?.at ?? "")),
    }).toMatchObject({
      dated: true,
      newest: {
        source: "screen",
        kind: "console",
        version: 1,
        screen: "notes",
        message: "x".repeat(2000),
      },
      oldest: {
        kind: "error",
        message: "Invoice 7 has no total",
        stack: "at Notes (app~screens~notes.js:3:9)",
      },
      rest: [],
      refused: [
        "screen.invalid",
        "screen.invalid",
        "screen.invalid",
        "app.version_not_found",
      ],
    });
  });

  it("keeps only the newest hundred problems", async () => {
    const builder = await personApi("builder");
    const app = await sampleApp(builder);
    for (let count = 1; count <= 101; count += 1) {
      // oxlint-disable-next-line no-await-in-loop -- in order
      await builder.api.screens.report(
        app,
        { version: 1, screen: "notes" },
        { kind: "error", message: `Problem ${count}` }
      );
    }
    const log = await builder.api.screens.errors(app);
    expect({
      entries: log.length,
      newest: log[0]?.message,
      oldest: log.at(-1)?.message,
    }).toStrictEqual({
      entries: 100,
      newest: "Problem 101",
      oldest: "Problem 2",
    });
  });
});
