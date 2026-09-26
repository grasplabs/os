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
    const added = await callAuth(
      "/organization/add-team-member",
      admin.session,
      {
        teamId: id,
        userId: member.userId,
      }
    );
    if (!added.ok) {
      throw new Error(`Adding ${member.userId} to the team failed`);
    }
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
 * A permission stored as it is, past the checks a request and a grant
 * make, as a bug or an old record could leave one: active by default, for
 * the reads and calls to refuse what it shouldn't allow on their own, or
 * requested, for a grant to refuse. Returns its ID.
 */
export const storedGrant = async (
  subject: { type: "app" | "agent"; id: string },
  object: { type: "collection" | "connection"; id: string },
  actions: string[],
  binding: string,
  status: "active" | "requested" = "active"
): Promise<string> => {
  const id = crypto.randomUUID();
  const grantedBy = status === "active" ? "test" : null;
  const grantedAt = status === "active" ? 0 : null;
  await env.DB.prepare(
    `INSERT INTO permissions (id, subject_type, subject_id, object_type, object_id,
      actions, binding, status, requested_by, requested_at, granted_by, granted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', 0, ?, ?)`
  )
    .bind(
      id,
      subject.type,
      subject.id,
      object.type,
      object.id,
      JSON.stringify(actions),
      binding,
      status,
      grantedBy,
      grantedAt
    )
    .run();
  return id;
};
