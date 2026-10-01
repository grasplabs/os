import type { ChatCode, ChatMessage, ChatPartial } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Trans, useLingui } from "@lingui/react/macro";

import { ErrorText } from "../error-text.tsx";
import { PlainMarkdown } from "../knowledge/markdown.tsx";

// A chat's messages as the person reads them: their questions, the agent's
// answers in Markdown, and each code step it ran, folded, with its result.

type Result = Extract<ChatMessage, { role: "result" }>;

/** One code step: the code, and its result once it has one. */
const CodeStep = ({
  code,
  result,
  writing,
  running,
}: {
  code: ChatCode;
  result: Result | undefined;
  /** Still being written by the model. */
  writing: boolean;
  /** Whether the agent is working on the chat now. */
  running: boolean;
}) => {
  const { t } = useLingui();
  // Without a result once the agent stopped, it never finished.
  let status = running ? t`Running` : t`Stopped`;
  if (writing) {
    status = t`Writing`;
  } else if (result !== undefined) {
    status = result.failed ? t`Failed` : t`Done`;
  }
  return (
    <details className="rounded-md border">
      <summary className="flex cursor-pointer items-center gap-2 p-2 text-sm">
        <Trans>Code step</Trans>
        <Badge variant={result?.failed === true ? "destructive" : "secondary"}>
          {status}
        </Badge>
      </summary>
      <div className="flex flex-col gap-2 border-t p-2">
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm">
          <code className="font-mono">{code.code}</code>
        </pre>
        {result === undefined ? null : (
          <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm">
            <code className="font-mono">{result.text}</code>
          </pre>
        )}
      </div>
    </details>
  );
};

/** One response of the agent's, stored or being written. */
const Reply = ({
  reply,
  results,
  writing,
  running,
}: {
  reply: ChatPartial & { end?: string; error?: string };
  results: ReadonlyMap<string, Result>;
  writing: boolean;
  running: boolean;
}) => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-2">
      {reply.text === "" ? null : <PlainMarkdown text={reply.text} />}
      {reply.code.map((code) => (
        <CodeStep
          code={code}
          key={code.callId}
          result={results.get(code.callId)}
          running={running}
          writing={writing}
        />
      ))}
      {reply.end === "cancelled" ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Stopped.</Trans>
        </p>
      ) : null}
      {reply.end === "cut_off" ? (
        <p className="text-muted-foreground text-sm">
          <Trans>The answer was cut off at the model&apos;s limit.</Trans>
        </p>
      ) : null}
      {reply.end === "failed" ? (
        <ErrorText>{reply.error ?? t`The model call failed.`}</ErrorText>
      ) : null}
    </div>
  );
};

/** The chat's messages, and the response being written, oldest first. */
export const Conversation = ({
  messages,
  partial,
  running,
}: {
  messages: readonly ChatMessage[];
  partial: ChatPartial | null;
  /** Whether the agent is working on the chat now. */
  running: boolean;
}) => {
  const { t } = useLingui();
  const results = new Map<string, Result>();
  for (const message of messages) {
    if (message.role === "result") {
      results.set(message.callId, message);
    }
  }
  return (
    <ol aria-label={t`Messages`} className="flex flex-col gap-4">
      {messages.map((message) => {
        if (message.role === "user") {
          return (
            <li
              className="bg-muted self-end rounded-lg px-3 py-2 whitespace-pre-wrap"
              key={message.id}
            >
              {message.text}
            </li>
          );
        }
        if (message.role === "assistant") {
          return (
            <li key={message.id}>
              <Reply
                reply={message}
                results={results}
                running={running}
                writing={false}
              />
            </li>
          );
        }
        return null;
      })}
      {partial === null ? null : (
        <li aria-busy="true">
          <Reply reply={partial} results={results} running={running} writing />
        </li>
      )}
    </ol>
  );
};
