import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// Guest chats (core's guests.ts): an App, under a permission an admin
// grants it (`{ type: "platform" }`, action `guests`), invites someone who
// isn't a member to a short chat with a model, guided by one of the
// release's Grasp skills, through a link only they get. The guest reaches
// nothing: no Knowledge, no connections, no Apps, no memory, no tools. The
// model only talks with them, and what they write is kept, as untrusted
// text, for the App to read back and for people to review before any of
// it is used. The link is a secret of 256 random bits, kept by core only
// as its hash; it works until it expires, is revoked, or the guest
// finishes, and a chat takes a bounded number of turns, one at a time.

/** Where the guest's page talks to core: one POST per action. */
export const guestApiPath = "/api/guest";

/** Where a guest link leads: the page, with the secret after the `#`. */
export const guestPagePath = "/guest";

/** Longest guest name, as the member who invites them writes it. */
export const guestNameMaxLength = 100;

/** Longest message a guest sends. */
export const guestMessageMaxLength = 1000;

/** Most turns (a guest message and its answer) one chat takes. */
export const guestTurnsMax = 20;

/** Longest a link works, in days, and how long unless the App says. */
export const guestDaysMax = 14;
export const guestDaysDefault = 7;

/** Most chats one App has open (neither ended nor expired) at once. */
export const guestOpenChatsMax = 50;

/** A guest link's secret: 32 random bytes, base64url. */
export const guestTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, "A guest link's secret");

/** What an App passes to invite a guest. */
export const guestInviteSchema = z.strictObject({
  /** Who is invited, as the member knows them: shown to the model too. */
  name: z.string().trim().min(1).max(guestNameMaxLength),
  /** The Grasp skill that guides the chat, by its name. */
  skill: z.string().min(1).max(64),
  /** How many days the link works. */
  days: z.int().min(1).max(guestDaysMax).default(guestDaysDefault),
});
export type GuestInvite = z.input<typeof guestInviteSchema>;

/** Where a guest chat stands. */
export type GuestChatStatus = "open" | "finished" | "revoked" | "expired";

/** A guest chat, as the App that made it lists it. */
export interface GuestChat {
  id: string;
  name: string;
  skill: string;
  status: GuestChatStatus;
  /** The member it was made for, whose model budget it spends. */
  invitedBy: string;
  /** Turns taken, of {@link guestTurnsMax}. */
  turns: number;
  /** ISO 8601. */
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
}

/** One message of a guest chat: the guest's, or the model's answer. */
export interface GuestMessage {
  role: "guest" | "agent";
  text: string;
  /** ISO 8601. */
  at: string;
}

/** A guest chat read back by its App: untrusted text, for review. */
export interface GuestTranscript extends GuestChat {
  messages: GuestMessage[];
}

/** What inviting answers: the link, shown once, never kept by core. */
export interface GuestInvitation extends GuestChat {
  link: string;
}

/** What the guest's page sends. */
export const guestRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("open"), token: guestTokenSchema }),
  z.strictObject({
    action: z.literal("send"),
    token: guestTokenSchema,
    text: z.string().trim().min(1).max(guestMessageMaxLength),
  }),
  z.strictObject({ action: z.literal("finish"), token: guestTokenSchema }),
]);
export type GuestRequest = z.input<typeof guestRequestSchema>;

/** What the guest's page is shown: the chat so far, and what's left. */
export interface GuestView {
  name: string;
  status: GuestChatStatus;
  messages: GuestMessage[];
  turnsLeft: number;
  expiresAt: string;
}

/** Why a guest chat call was refused. */
export const guestErrors = defineErrorFamily({
  "guest.link_invalid":
    "This link doesn't work. Ask whoever sent it for a new one.",
  "guest.ended": "This chat has ended. Thank you for your time.",
  "guest.busy": "Still answering your last message. Wait for it, then send.",
  "guest.no_turns_left":
    "This chat has reached its length. Finish it to send what you wrote.",
  "guest.invalid": "That isn't something a guest chat takes.",
  "guest.not_found": "There's no such guest chat for this App.",
  "guest.too_many_open":
    "This App has too many open guest chats. Revoke some, or wait for them to end.",
  "guest.no_model":
    "No model is set up for this deployment, so no guest can chat.",
  "guest.unavailable":
    "The chat can't answer right now. Try sending it again in a while.",
});
