import { deploymentConfig } from "@grasp-os/shared/config";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import {
  memoryCharactersPerToken,
  memoryDefaultLimits,
  memoryLimitsSchema,
  memoryTokens,
} from "@grasp-os/shared/memory";
import type { MemoryFileName } from "@grasp-os/shared/memory";

// Where memory files live, and how large each may be. The save pipeline
// (documents.ts) keeps every memory file to its limit, and memory.ts reads
// them for a context.

/**
 * The Memory collection: the company's AGENTS.md and MEMORY.md, and each
 * agent's AGENTS.md. One per deployment, under this ID, which no other
 * collection can have: every other one's is a random UUID.
 */
export const memoryCollectionId: CollectionId =
  collectionIdSchema.parse("memory");

/**
 * The ID of the Personal collection of the person `userId`, which holds
 * their USER.md: made from their ID, so it is found without a lookup, and
 * never a random UUID another collection could have. Hashed, so it's
 * identifier-sized however long the user ID is.
 */
export const personalCollectionId = async (
  userId: string
): Promise<CollectionId> =>
  collectionIdSchema.parse(`personal:${await sha256Hex(userId)}`);

/** Where an App's AGENTS.md is in its code. */
export const appMemoryPath = "AGENTS.md";

/** Where the agent `agentId`'s AGENTS.md is in the Memory collection. */
export const agentMemoryPath = (agentId: string): string =>
  `agents/${agentId}/AGENTS.md`;

/**
 * The memory file the document at `path` in `collection` is, if it is one:
 * every AGENTS.md and MEMORY.md in the Memory collection (the company's,
 * agents', and any other, so no path there escapes the limits), and
 * USER.md in its owner's Personal collection.
 */
export const memoryFileOf = async (
  collection: { id: string; owner: string },
  path: string
): Promise<MemoryFileName | undefined> => {
  if (collection.id === memoryCollectionId) {
    const name = path.split("/").at(-1);
    return name === "AGENTS.md" || name === "MEMORY.md" ? name : undefined;
  }
  if (
    path === "USER.md" &&
    collection.id === (await personalCollectionId(collection.owner))
  ) {
    return "USER.md";
  }
  return undefined;
};

/**
 * The size limit of `name`, in tokens: the deployment's `MEMORY_LIMITS`,
 * else the default. A var that doesn't parse is logged and counts as unset.
 */
export const memoryLimit = (env: Env, name: MemoryFileName): number =>
  deploymentConfig(memoryLimitsSchema, "MEMORY_LIMITS", env.MEMORY_LIMITS)?.[
    name
  ] ?? memoryDefaultLimits[name];

/**
 * Refuses `text` for the memory file `name` when it is over its limit, with
 * `knowledge.memory_too_large`: how large it is and may be, in tokens and
 * about as many characters.
 */
export const requireWithinLimit = (
  env: Env,
  name: MemoryFileName,
  text: string
): void => {
  const maxTokens = memoryLimit(env, name);
  const tokens = memoryTokens(text);
  if (tokens > maxTokens) {
    throw knowledgeErrors.create("knowledge.memory_too_large", {
      file: name,
      tokens,
      maxTokens,
      maxCharacters: maxTokens * memoryCharactersPerToken,
    });
  }
};
