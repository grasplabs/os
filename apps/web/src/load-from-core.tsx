import { messageOf } from "@grasp-os/shared/errors";

import { CoreTimeoutError, withSession, withTimeout } from "./core.ts";
import type { Session } from "./core.ts";
import { ErrorText } from "./error-text.tsx";

/** What a page read from core: its data, or why there is none. */
export type Loaded<T> =
  | { state: "offline" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

/**
 * Reads a page's data with `read`, on the signed-in person's session,
 * within a few seconds: a read that hangs counts as core being out of
 * reach, and a refusal carries core's reason.
 */
export const loadFromCore = async <T,>(
  read: (session: Session) => Promise<T>
): Promise<Loaded<T>> => {
  try {
    const data = await withSession(
      async (session) => await withTimeout(read(session))
    );
    return { state: "ready", data };
  } catch (error) {
    if (error instanceof CoreTimeoutError) {
      return { state: "offline" };
    }
    return { state: "refused", message: messageOf(error) };
  }
};

/** Why a page has no data to show; nothing once it has. */
export const NotLoaded = ({ page }: { page: Loaded<unknown> }) => {
  if (page.state === "offline") {
    return (
      <ErrorText>
        Grasp can&apos;t be reached right now. Try again in a moment.
      </ErrorText>
    );
  }
  return page.state === "refused" ? (
    <ErrorText>{page.message}</ErrorText>
  ) : null;
};
