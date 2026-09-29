import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type {
  ChatCode,
  ChatMessage,
  ChatPartial,
  ChatReplyEnd,
} from "@grasp-os/shared/chat";

// A chat's transcript as pi keeps it (workspace.ts), shown as the person
// reads it: their questions, the agent's answers with the code it ran,
// and each code step's result. The agent's instructions, the APIs and the
// memory it was shown, and its reasoning stay out.

/** The text parts of a message's content, joined. */
const textOf = (
  content: string | readonly { type: string; text?: string }[]
): string =>
  typeof content === "string"
    ? content
    : content
        .flatMap((part) =>
          part.type === "text" && typeof part.text === "string"
            ? [part.text]
            : []
        )
        .join("");

/**
 * The code a response asked to run: each `executeCode` call's code, as far
 * as it has streamed in (pi parses the call's arguments as they come).
 */
const codeOf = (message: AssistantMessage): ChatCode[] =>
  message.content.flatMap((part) => {
    if (part.type !== "toolCall") {
      return [];
    }
    const { code } = part.arguments;
    return [{ callId: part.id, code: typeof code === "string" ? code : "" }];
  });

const ends: Record<AssistantMessage["stopReason"], ChatReplyEnd> = {
  stop: "done",
  toolUse: "done",
  // Neither ends a response this loop keeps; shown as done if one did.
  pending: "done",
  deferred: "done",
  length: "cut_off",
  aborted: "cancelled",
  error: "failed",
};

/** A response being written, as the person sees it so far. */
export const partialOf = (message: AssistantMessage): ChatPartial => ({
  text: textOf(message.content),
  code: codeOf(message),
});

/** A stored message as the person reads it; `undefined` for a system one. */
export const chatMessageOf = (
  id: number,
  message: Message,
  createdAt: Date
): ChatMessage | undefined => {
  const at = createdAt.toISOString();
  if (message.role === "user") {
    return { id, role: "user", text: textOf(message.content), at };
  }
  if (message.role === "assistant") {
    return {
      id,
      role: "assistant",
      ...partialOf(message),
      end: ends[message.stopReason],
      ...(message.stopReason === "error" && message.errorMessage !== undefined
        ? { error: message.errorMessage }
        : {}),
      at,
    };
  }
  if (message.role === "toolResult") {
    return {
      id,
      role: "result",
      callId: message.toolCallId,
      text: textOf(message.content),
      failed: message.isError,
      at,
    };
  }
  return undefined;
};
