// What the board page's server answers (app/server.ts), as its screen
// reads it.

import { callServer } from "@grasp-os/sdk/screen";

/** A snapshot as the page lists it. */
export interface Listed {
  id: string;
  path: string;
  title: string;
}

/** The Playbook's snapshots, and whether the page may read them. */
export interface Snapshots {
  access: "none" | "ok";
  snapshots: Listed[];
}

/** A snapshot at its current version. */
export interface Snapshot {
  id: string;
  path: string;
  version: number;
  record: Record<string, unknown>;
  body: string;
}

/** A server call's answer, or the code of why it was refused. */
export type Outcome<T> = { ok: T } | { error: string };

const codeOf = (error: unknown): string =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string"
    ? error.code
    : "app.failed";

/**
 * Calls the server's `method`: its answer, or, when the call itself fails
 * (the connection, the platform), why, as a refusal the page shows.
 */
export const ask = async <T>(
  method: string,
  ...args: unknown[]
): Promise<Outcome<T>> => {
  try {
    return await callServer<Outcome<T>>(method, ...args);
  } catch (error) {
    return { error: codeOf(error) };
  }
};

/** What a refusal means to the person using the page. */
export const refusal = (code: string): string => {
  switch (code) {
    case "knowledge.conflict": {
      return "Someone saved this snapshot since you opened it. Open it again to see their changes.";
    }
    case "knowledge.forbidden": {
      return "Only admins change the Playbook.";
    }
    case "knowledge.invalid": {
      return "That can't be saved: check the decision is under 1,000 characters.";
    }
    case "knowledge.not_found": {
      return "There's no such snapshot, or you can't open it.";
    }
    case "board.not_snapshot": {
      return "That document isn't a snapshot.";
    }
    case "board.figures_incomplete": {
      return "The Apps linked here ran more workflows than one snapshot reads, so it wasn't taken: its figures would be incomplete.";
    }
    case "board.too_many_workflows": {
      return "The Playbook has more workflows than one snapshot holds (250).";
    }
    case "permission.denied": {
      return "The page can't use the Playbook: an admin approves its permission first.";
    }
    case "permission.restricted": {
      return "The page read restricted data, so it can't write to the Playbook, which everyone reads.";
    }
    default: {
      return `That didn't work (${code}).`;
    }
  }
};
