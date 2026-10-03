import type { Collection } from "@grasp-os/shared/knowledge";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { loadMemory } from "./memory.ts";
import type { MemoryFiles } from "./memory.ts";

/** What Knowledge's navigation shows, as the page read it. */
export interface KnowledgeNavData {
  collections: Loaded<Collection[]>;
  memory: Loaded<MemoryFiles>;
}

/**
 * The memory files, then the collections: asking for memory creates the
 * Personal collection on a first visit (and an admin's Memory
 * collection), which the list then has. Each says on its own why it
 * failed; the list is read whatever memory's outcome. Asking for memory
 * isn't sent once the page was `left`: nobody asked for those collections.
 */
export const loadKnowledgeNav = async (
  core: CoreConnection,
  left: AbortSignal
): Promise<KnowledgeNavData> => {
  const memory = await loadFromCore(core, loadMemory, left);
  const collections = await loadFromCore(
    core,
    async (session) => await session.knowledge.listCollections()
  );
  return { memory, collections };
};
