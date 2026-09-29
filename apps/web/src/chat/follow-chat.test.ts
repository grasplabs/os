import type { ChatMessage, ChatUpdate } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { applyUpdate, emptyView } from "./follow-chat.ts";

// How the chat page puts a chat together from the updates core streams:
// pure logic, so tested on its own.

const at = "2026-09-29T00:00:00.000Z";

const question = (id: number, text: string): ChatMessage => ({
  id,
  role: "user",
  text,
  at,
});

const update = (changes: Partial<ChatUpdate> = {}): ChatUpdate => ({
  messages: [],
  partial: null,
  running: false,
  stopped: null,
  held: 0,
  ...changes,
});

describe("a chat as the page shows it", () => {
  it("drops why the last question stopped once the next one runs", () => {
    const stopped = applyUpdate(
      emptyView,
      update({ stopped: "This isn't switched on for this deployment." })
    );
    const next = applyUpdate(stopped, update({ running: true }));

    expect([stopped.stopped, next.stopped]).toStrictEqual([
      "This isn't switched on for this deployment.",
      null,
    ]);
  });

  it("follows core's count of held writes, which the page reads again on", () => {
    const once = applyUpdate(emptyView, update({ held: 1 }));
    const twice = applyUpdate(once, update({ held: 2 }));

    expect([emptyView.held, once.held, twice.held]).toStrictEqual([0, 1, 2]);
  });

  it("adds each message once, in order, and keeps provenance until it changes", () => {
    const first = applyUpdate(
      emptyView,
      update({
        messages: [question(1, "One")],
        provenance: { sources: ["handbook"], restricted: false },
      })
    );
    // A reconnect may send a message the page has already.
    const again = applyUpdate(
      first,
      update({ messages: [question(1, "One"), question(2, "Two")] })
    );

    expect({
      texts: again.messages.map(({ text }) => text),
      provenance: again.provenance,
    }).toStrictEqual({
      texts: ["One", "Two"],
      provenance: { sources: ["handbook"], restricted: false },
    });
  });
});
