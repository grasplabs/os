import { requestIdOf, withReference } from "@grasp-os/shared/errors";
import { guestApiPath } from "@grasp-os/shared/guests";
import type { GuestRequest, GuestView } from "@grasp-os/shared/guests";
import { requestIdHeader } from "@grasp-os/shared/http";

// A guest's page talks to core over one endpoint, with the secret from its
// link in each request's body: it has no session, and never opens `/rpc`.

/** A guest call's answer: the chat as it is now, or why it was refused. */
export type GuestAnswer = { ok: GuestView } | { error: string };

/** How long a call may take: past the model's answer. */
const callTimeoutMs = 90_000;

/** The message of a refusal core sent, if it sent one. */
const messageIn = (payload: unknown): string | undefined =>
  typeof payload === "object" &&
  payload !== null &&
  "message" in payload &&
  typeof payload.message === "string"
    ? payload.message
    : undefined;

/** Sends one request of the guest's page, and reads the answer. */
export const guestCall = async (
  request: GuestRequest
): Promise<GuestAnswer> => {
  try {
    const response = await fetch(guestApiPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      // No cookie of anyone's goes with it: the secret is all it has.
      credentials: "omit",
      signal: AbortSignal.timeout(callTimeoutMs),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      return {
        error: withReference(
          messageIn(payload) ?? "That didn't work. Try again in a moment.",
          requestIdOf(payload) ??
            response.headers.get(requestIdHeader) ??
            undefined
        ),
      };
    }
    // SAFETY: core's guest endpoint answers a `GuestView` when it succeeds.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return { ok: payload as GuestView };
  } catch {
    return {
      error: "Grasp can't be reached right now. Try again in a moment.",
    };
  }
};

/** The secret in the page's link: what follows its `#`. */
export const linkSecret = (): string => window.location.hash.slice(1);
