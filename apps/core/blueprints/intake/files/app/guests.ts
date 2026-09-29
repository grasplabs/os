// Stakeholder chats: the intake invites someone on the team who isn't a
// member to a short chat about their work, through the platform's guest
// chats (the `GUESTS` permission an admin grants), guided by the Grasp
// skill `interview-a-stakeholder`. What they write comes back as notes,
// which the `extract` workflow reads like any other, into a draft someone
// reviews. Their words are untrusted: the source they become is marked
// `guest` (app/records.json), which only the intake's save sets.

import { notesMax } from "./draft.ts";
import type { DraftSource } from "./draft.ts";

/** The skill a stakeholder's chat follows. */
export const interviewSkill = "interview-a-stakeholder";

/** Where a guest chat stands. */
export type GuestChatStatus = "open" | "finished" | "revoked" | "expired";

/** A guest chat, as the platform lists it. */
export interface GuestChat {
  id: string;
  name: string;
  status: GuestChatStatus;
  invitedBy: string;
  turns: number;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
}

/** A guest chat with what was written in it. */
export interface GuestTranscript extends GuestChat {
  messages: { role: "guest" | "agent"; text: string; at: string }[];
}

/** The platform's guest chats, as the App's permission gives them. */
export interface Guests {
  invite: (
    caller: unknown,
    input: { name: string; skill: string; days?: number }
  ) => Promise<GuestChat & { link: string }>;
  list: (caller: unknown) => Promise<GuestChat[]>;
  read: (caller: unknown, id: string) => Promise<GuestTranscript>;
  revoke: (caller: unknown, id: string) => Promise<GuestChat>;
}

/** Most characters of one answer the notes keep: its question, mostly. */
const answerKept = 300;

/**
 * A chat as notes to read: each question, shortened, and each of the
 * guest's answers, whole, within the notes' limit. Named so the model
 * can tell who said what.
 */
export const notesOf = (chat: GuestTranscript): string => {
  const lines = chat.messages.map(({ role, text }) =>
    role === "guest"
      ? `${chat.name}: ${text}`
      : `Question: ${text.length > answerKept ? `${text.slice(0, answerKept)}…` : text}`
  );
  const notes = lines.join("\n\n");
  return notes.length > notesMax ? notes.slice(0, notesMax) : notes;
};

/** The source a chat is: a chat with the guest, on the day it ended. */
export const sourceOf = (
  chat: GuestTranscript
): Omit<DraftSource, "notes"> => ({
  title: `Chat with ${chat.name}`.slice(0, 200),
  medium: "chat",
  date: (chat.endedAt ?? chat.createdAt).slice(0, 10),
  from: chat.name,
});
