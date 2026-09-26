import type { CollectionInput, KnowledgeApi } from "@grasp-os/shared/knowledge";
import type {
  PermissionRequest,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { callAuth, unique } from "./sign-in.ts";

/** A new team with `members`, made by an admin; returns its ID. */
export const newTeam = async (
  admin: { session: string },
  members: { userId: string }[]
): Promise<string> => {
  const created = await callAuth("/organization/create-team", admin.session, {
    name: `Team ${unique()}`,
  });
  const { id } = z.object({ id: z.string() }).parse(await created.json());
  for (const member of members) {
    // oxlint-disable-next-line no-await-in-loop -- one member at a time
    await callAuth("/organization/add-team-member", admin.session, {
      teamId: id,
      userId: member.userId,
    });
  }
  return id;
};

/** A collection with one document, `note.md`, that links to itself. */
export const collectionWithNote = async (
  owner: { knowledge: KnowledgeApi },
  input: CollectionInput
) => {
  const collection = await owner.knowledge.createCollection(input);
  const note = await owner.knowledge.saveDocument({
    collectionId: collection.id,
    path: "note.md",
    text: "# Note\nSee [[note.md]] and [[other.md]].",
    ifVersion: 0,
  });
  await owner.knowledge.saveDocument({
    collectionId: collection.id,
    path: "other.md",
    text: "# Other\nBack to [[note.md]].",
    ifVersion: 0,
  });
  return { collectionId: collection.id, noteId: note.id };
};

/** A permission to read a collection, under `binding`. */
export const readCollection = (
  subject: PermissionSubjectInput,
  collectionId: string,
  binding = "HANDBOOK"
): PermissionRequest => ({
  subject,
  object: { type: "collection", collectionId },
  actions: ["read"],
  binding,
});

/**
 * An active permission stored as it is, past the checks a request and a
 * grant make, as a bug or an old record could leave one: the reads and
 * calls must refuse what it shouldn't allow on their own.
 */
export const storedGrant = async (
  subject: { type: "app" | "agent"; id: string },
  object: { type: "collection" | "connection"; id: string },
  actions: string[],
  binding: string
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'test', 0, 'test', 0)`
  )
    .bind(
      crypto.randomUUID(),
      subject.type,
      subject.id,
      object.type,
      object.id,
      JSON.stringify(actions),
      binding
    )
    .run();
};
