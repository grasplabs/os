import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { chatAuthority, chatContext, requireOpenRun } from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { forSandbox } from "./bindings.ts";
import { saveUserMemory } from "./knowledge/memory.ts";

// Memory for a chat's code: `await env.memory.saveUser({ text, ifVersion })`.
// The chat is its person's own (`own` in knowledge/memory.ts), so its agent
// keeps what it knows about them in their USER.md, which every chat of
// theirs then has in its memory. Saved as the chat's agent acting for
// them, in their Personal collection: each version is in its history and
// recorded in the audit log there. A chat that read restricted data can't
// save one, which would carry that data into their next chats.

/** Memory, as a chat's code writes it. */
export class MemoryApi extends WorkerEntrypoint<Env, AgentScope> {
  /** Saves the person's USER.md from version `ifVersion` (0 for their first). */
  async saveUser(input: unknown): Promise<{ version: number }> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope);
    try {
      const saved = await saveUserMemory(
        this.env,
        chatAuthority(scope),
        chatContext(scope),
        { type: "own" },
        input
      );
      return { version: saved.currentVersion };
    } catch (error) {
      throw forSandbox(error);
    }
  }
}

/** What the model reads of `env.memory`. */
const memoryDeclaration = `/** What you keep about the person, in their USER.md, which every chat of theirs has in its memory. */
memory: {
  /**
   * Saves their whole USER.md: what you know about them worth keeping,
   * short. \`ifVersion\` is the version your memory shows (0 while there is
   * none); if it changed meanwhile, the save is refused.
   */
  saveUser(input: { text: string; ifVersion: number; message?: string }): Promise<{ version: number }>;
};`;

/** `env.memory`. */
export const memoryApi: AgentApi = {
  name: "memory",
  declaration: memoryDeclaration,
  stub: (scope) => exports.MemoryApi({ props: scope }),
};
