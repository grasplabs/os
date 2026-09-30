import { messageOf } from "@grasp-os/shared/errors";

import { readWithin } from "./core-connection.ts";
import type { CoreConnection } from "./core-connection.ts";
import { CoreTimeoutError, deadline } from "./core.ts";
import type { Session } from "./core.ts";
import { ErrorText } from "./error-text.tsx";

/** What a page read from core: its data, or why there is none. */
export type Loaded<T> =
  | { state: "offline" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

/**
 * Reads a page's data with `read`, on the signed-in person's session over
 * the tab's connection, within a few seconds (`readWithin`): a read that
 * hangs, or waits that long for a connection, counts as core being out of
 * reach, and a refusal carries core's reason. Given `left`, the page's
 * signal that it was left, a read still waiting for a connection then is
 * never sent.
 */
export const loadFromCore = async <T,>(
  core: CoreConnection,
  read: (session: Session) => Promise<T>,
  left?: AbortSignal
): Promise<Loaded<T>> => {
  const signal =
    left === undefined ? deadline() : AbortSignal.any([deadline(), left]);
  try {
    const data = await readWithin(core, read, signal);
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
