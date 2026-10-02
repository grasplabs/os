import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import { memoryFileNames } from "@grasp-os/shared/memory";

import type { Session } from "../core.ts";

/** The memory files in the person's own context, and where they are. */
export interface MemoryFiles {
  /** The company's Memory collection, `null` until an admin sets it up. */
  memory: string | null;
  /** The person's Personal collection, with their USER.md. */
  personal: string;
  files: DocumentSummary[];
}

const memoryFilePaths = new Set<string>(memoryFileNames);

/**
 * The company's AGENTS.md and MEMORY.md and the person's USER.md, those
 * written so far: the files at the root of the two collections by those
 * names. An agent's own AGENTS.md sits deeper, and only that agent gets it.
 * They are on the first page: in path order, names in capitals come before
 * the folders (`agents/…`) the Memory collection has. Asking for the
 * collections creates what doesn't exist yet: the person's Personal
 * collection on their first visit, and the company's Memory collection
 * when an admin opens the page before it is set up.
 */
export const loadMemory = async (session: Session): Promise<MemoryFiles> => {
  const { memory, personal } = await session.memory.collections();
  const pages = await Promise.all(
    [memory, personal]
      .filter((id) => id !== null)
      .map(async (id) => await session.knowledge.listDocuments(id))
  );
  const files = pages
    .flatMap(({ documents }) => documents)
    .filter(({ path }) => memoryFilePaths.has(path));
  return { memory, personal, files };
};
