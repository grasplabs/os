import type { ChatCode, ChatMessage, ChatPartial } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ArrowDownIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  CodeIcon,
  CopyIcon,
  RefreshCcwIcon,
  TriangleAlertIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { PlainMarkdown } from "../knowledge/markdown.tsx";
import { GraspEyes } from "./grasp-eyes.tsx";
import type { EyesState } from "./grasp-eyes.tsx";

// A chat as the person reads it, in the prototype's look
// (grasplabs/prototype `components/chat/chat-thread.tsx` and
// `chat-message.tsx`): their questions in a grey bubble on the right,
// Grasp's answers beside its eyes, each code step folded with its status,
// and a line while Grasp reads before its answer starts. It follows the
// answer as it streams, unless the person scrolls up to read.

type Result = Extract<ChatMessage, { role: "result" }>;
type Answer = Extract<ChatMessage, { role: "assistant" }>;
type StepStatus = "writing" | "running" | "done" | "failed" | "stopped";

const statusIcon: Record<StepStatus, ReactNode> = {
  writing: <CircleIcon className="size-3.5" />,
  running: <ClockIcon className="size-3.5 animate-pulse" />,
  done: <CheckCircleIcon className="text-status-agreed size-3.5" />,
  failed: <XCircleIcon className="text-destructive size-3.5" />,
  stopped: <XCircleIcon className="text-status-attention size-3.5" />,
};

/** Where a code step stands: written, running, done, failed or stopped. */
const stepStatusOf = (
  result: Result | undefined,
  writing: boolean,
  running: boolean
): StepStatus => {
  if (writing) {
    return "writing";
  }
  if (result !== undefined) {
    return result.failed ? "failed" : "done";
  }
  // Without a result once the agent stopped, it never finished.
  return running ? "running" : "stopped";
};

/** One code step, folded: its status, and the code and result on opening. */
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
  const status = stepStatusOf(result, writing, running);
  const label = {
    writing: t`Writing`,
    running: t`Running`,
    done: t`Done`,
    failed: t`Failed`,
    stopped: t`Stopped`,
  }[status];
  return (
    <details className="group w-full rounded-md border">
      <summary className="flex w-full cursor-pointer list-none items-center justify-between gap-4 p-3 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <CodeIcon className="text-muted-foreground size-4" />
          <span className="text-sm font-medium">
            <Trans>Code step</Trans>
          </span>
          <Badge variant="secondary">
            {statusIcon[status]}
            {label}
          </Badge>
        </span>
        <ChevronDownIcon className="text-muted-foreground size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="flex flex-col gap-4 px-4 pb-4">
        <section className="flex flex-col gap-2">
          <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            <Trans>Code</Trans>
          </h4>
          <pre className="bg-muted/50 overflow-x-auto rounded-md p-3 text-xs">
            <code className="font-mono">{code.code}</code>
          </pre>
        </section>
        {result === undefined ? null : (
          <section className="flex flex-col gap-2">
            <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {result.failed ? <Trans>Error</Trans> : <Trans>Result</Trans>}
            </h4>
            <pre
              className={
                result.failed
                  ? "bg-destructive/10 text-destructive overflow-x-auto rounded-md p-3 text-xs"
                  : "bg-muted/50 overflow-x-auto rounded-md p-3 text-xs"
              }
            >
              <code className="font-mono">{result.text}</code>
            </pre>
          </section>
        )}
      </div>
    </details>
  );
};

/** A small button under an answer, named by its tooltip. */
const AnswerAction = ({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          aria-label={label}
          onClick={onClick}
          size="icon-sm"
          variant="ghost"
        />
      }
    >
      {children}
    </TooltipTrigger>
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

/** Copies the answer's text, and says so for a moment. */
const CopyAnswer = ({ text }: { text: string }) => {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = copied
      ? setTimeout(() => {
          setCopied(false);
        }, 1500)
      : undefined;
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };
  return (
    <AnswerAction
      label={copied ? t`Copied` : t`Copy the answer`}
      onClick={() => {
        void copy();
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </AnswerAction>
  );
};

/** What an answer's eyes show: while it is written, what it writes now. */
const eyesOf = (
  reply: ChatPartial & { end?: string },
  writing: boolean,
  results: ReadonlyMap<string, Result>
): EyesState => {
  if (writing) {
    const last = reply.code.at(-1);
    if (last !== undefined && !results.has(last.callId)) {
      return "working";
    }
    return reply.text === "" ? "thinking" : "writing";
  }
  return reply.end === "failed" ? "error" : "idle";
};

/** One response of the agent's, stored or being written. */
const Reply = ({
  reply,
  results,
  writing,
  running,
  latest,
  onRetry,
}: {
  reply: ChatPartial & { end?: Answer["end"]; error?: string };
  results: ReadonlyMap<string, Result>;
  writing: boolean;
  running: boolean;
  /** The newest answer: the only one whose eyes move. */
  latest: boolean;
  /** Asks the last question again, offered under the last answer. */
  onRetry?: () => void;
}) => {
  const { t } = useLingui();
  const answer = reply.text.trim();
  return (
    <div className="flex w-full items-start gap-3">
      <GraspEyes live={latest} state={eyesOf(reply, writing, results)} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex w-full min-w-0 flex-col gap-3 text-sm">
          {answer === "" ? null : <PlainMarkdown text={reply.text} />}
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
            <p className="text-muted-foreground">
              <Trans>Stopped.</Trans>
            </p>
          ) : null}
          {reply.end === "cut_off" ? (
            <p className="text-muted-foreground">
              <Trans>The answer was cut off at the model&apos;s limit.</Trans>
            </p>
          ) : null}
          {reply.end === "failed" ? (
            <div className="flex items-start gap-3 rounded-lg border px-3.5 py-3">
              <TriangleAlertIcon className="text-destructive mt-0.5 size-4 flex-none" />
              <p className="flex-1" role="alert">
                {reply.error ?? t`The model call failed.`}
              </p>
              {onRetry === undefined ? null : (
                <Button onClick={onRetry} size="sm" variant="outline">
                  <RefreshCcwIcon data-icon="inline-start" />
                  <Trans>Try again</Trans>
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {writing || (answer === "" && onRetry === undefined) ? null : (
          <div className="-ml-1.5 flex items-center gap-1">
            {answer === "" ? null : <CopyAnswer text={answer} />}
            {onRetry === undefined || reply.end === "failed" ? null : (
              <AnswerAction label={t`Ask again`} onClick={onRetry}>
                <RefreshCcwIcon />
              </AnswerAction>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** Grasp, reading before its answer starts. */
const Reading = () => {
  const { t } = useLingui();
  return (
    <div className="flex items-start gap-3">
      <GraspEyes live state="reading" />
      <p className="shimmer-text text-sm">{t`Reading the workspace`}</p>
    </div>
  );
};

/**
 * Follows the end of `scroller` as what is in `content` grows, while the
 * person is at the end; scrolled up to read, it stays where they are.
 */
const useFollow = (): {
  scroller: React.RefObject<HTMLDivElement | null>;
  content: React.RefObject<HTMLOListElement | null>;
  atEnd: boolean;
  toEnd: () => void;
} => {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLOListElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  useEffect(() => {
    const box = scroller.current;
    const inner = content.current;
    if (box === null || inner === null) {
      return () => {
        // Nothing was followed.
      };
    }
    let following = true;
    const onScroll = (): void => {
      following = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
      setAtEnd(following);
    };
    const onGrow = new ResizeObserver(() => {
      if (following) {
        box.scrollTop = box.scrollHeight;
      }
    });
    box.scrollTop = box.scrollHeight;
    box.addEventListener("scroll", onScroll, { passive: true });
    onGrow.observe(inner);
    return () => {
      box.removeEventListener("scroll", onScroll);
      onGrow.disconnect();
    };
  }, []);
  const toEnd = (): void => {
    scroller.current?.scrollTo({
      top: scroller.current.scrollHeight,
      behavior: "smooth",
    });
  };
  return { scroller, content, atEnd, toEnd };
};

/** The chat's messages, and the response being written, oldest first. */
export const ChatThread = ({
  messages,
  partial,
  running,
  onRetry,
  children,
}: {
  messages: readonly ChatMessage[];
  partial: ChatPartial | null;
  /** Whether the agent is working on the chat now. */
  running: boolean;
  /** Asks the last question again. */
  onRetry: () => void;
  /** Shown after the messages, in the thread: what is held, why it stopped. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const { scroller, content, atEnd, toEnd } = useFollow();
  const results = new Map<string, Result>();
  for (const message of messages) {
    if (message.role === "result") {
      results.set(message.callId, message);
    }
  }
  const lastAnswer = messages.findLast(({ role }) => role === "assistant");
  // Grasp is reading until the answer shows its first words or code.
  const reading =
    running &&
    (partial === null ||
      (partial.text.trim() === "" && partial.code.length === 0));
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto" ref={scroller}>
        <ol
          aria-label={t`Messages`}
          className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 md:px-6"
          ref={content}
        >
          {messages.map((message) => {
            if (message.role === "user") {
              return (
                <li
                  className="bg-secondary text-foreground ml-auto w-fit max-w-11/12 rounded-lg px-4 py-3 text-sm whitespace-pre-wrap"
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
                    latest={partial === null && message === lastAnswer}
                    onRetry={
                      !running && message === lastAnswer ? onRetry : undefined
                    }
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
          {partial !== null && !reading ? (
            <li aria-busy="true">
              <Reply
                latest
                reply={partial}
                results={results}
                running={running}
                writing
              />
            </li>
          ) : null}
          {reading ? (
            <li aria-busy="true">
              <Reading />
            </li>
          ) : null}
          {children === undefined ? null : <li>{children}</li>}
        </ol>
      </div>
      {atEnd ? null : (
        <Button
          aria-label={t`Jump to the newest message`}
          className="absolute bottom-4 left-1/2 -translate-x-1/2"
          onClick={toEnd}
          size="icon"
          variant="outline"
        >
          <ArrowDownIcon />
        </Button>
      )}
    </div>
  );
};
