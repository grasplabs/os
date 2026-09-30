import type {
  ActionDescription,
  PendingAction,
} from "@grasp-os/shared/connect";
import { featureErrors, messageOf } from "@grasp-os/shared/errors";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { useEffect, useId, useState } from "react";

import { withSession } from "../core.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// The changes the chat's agent asked for in outside systems (sending,
// booking, deleting), which connect holds until the person confirms or
// rejects each (pending-actions.ts in core). Core lists only the person's
// own; this shows those from this chat. A write whose tool describes it
// reads as a title and the parts of its input that matter, each value the
// input's own, never a summary; any other shows its action and its input.
// Either way the exact input each runs with, which is what confirming
// names, is one click away, and open from the start whenever the card
// doesn't show all of it. Confirm waits until everything that will be
// sent has been shown in full.

/** What the page read of the chat's held writes. */
type Held =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; actions: PendingAction[] };

/**
 * The person's held writes from chat `chatId`, newest first. Outside the
 * component, as the React Compiler can't compile `try`.
 */
const readHeld = async (chatId: string): Promise<Held> => {
  try {
    const waiting = await withSession(
      async (session) => await session.pendingActions.list()
    );
    return {
      state: "ready",
      actions: waiting.filter(
        ({ context }) => context.type === "chat" && context.chatId === chatId
      ),
    };
  } catch (error) {
    // Held writes switched off (connections or confirmations): nothing to
    // show under the chat, rather than a refusal under every one.
    if (featureErrors.codeOf(error) === "feature.disabled") {
      return { state: "ready", actions: [] };
    }
    return { state: "refused", message: messageOf(error) };
  }
};

/** The input an action runs with, laid out to read. */
const inputOf = (input: string): string => {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
};

/** Lines of a value shown before the rest waits behind "Show all". */
const shownLines = 12;

/** Characters of a value shown before the rest waits behind "Show all". */
const shownCharacters = 1200;

/** How much of `value` a card shows before "Show all": its start, if not all. */
const startOf = (value: string): string =>
  value.split("\n").slice(0, shownLines).join("\n").slice(0, shownCharacters);

/** Whether a card starts `value` cut short. */
const isCutShort = (value: string): boolean =>
  startOf(value).length < value.length;

/**
 * A text value, exactly as the input holds it, all of it: no scroll box
 * hides a part. A very long one starts cut short, with a control that says
 * how much there is and shows it all (`onShowAll`), so what follows a run
 * of blank lines can't go unseen unnoticed.
 */
const TextValue = ({
  value,
  onShowAll,
}: {
  value: string;
  onShowAll: () => void;
}) => {
  const [all, setAll] = useState(false);
  const lines = value.split("\n");
  const start = startOf(value);
  const long = isCutShort(value);
  return (
    <dd className="flex flex-col items-start gap-1">
      <span className="break-words whitespace-pre-wrap">
        {all || !long ? value : `${start}…`}
      </span>
      {long ? (
        <Button
          aria-expanded={all}
          onClick={() => {
            if (!all) {
              onShowAll();
            }
            setAll(!all);
          }}
          size="sm"
          variant="outline"
        >
          {all
            ? "Show less"
            : `Show all ${lines.length} lines (${value.length} characters)`}
        </Button>
      ) : null}
    </dd>
  );
};

/** One value of a description, exactly as the input holds it. */
const FieldValue = ({
  value,
  onShowAll,
}: {
  value: string | string[];
  onShowAll: () => void;
}) =>
  typeof value === "string" ? (
    <TextValue onShowAll={onShowAll} value={value} />
  ) : (
    <dd>
      <ul className="flex flex-col">
        {value.map((item, index) => (
          // By position: the input's own order, and values may repeat.
          <li className="break-words whitespace-pre-wrap" key={index}>
            {item}
          </li>
        ))}
      </ul>
    </dd>
  );

/**
 * The parts of the input its tool shows, each under its label; `onShowAll`
 * names a value cut short once it is shown in full.
 */
const Described = ({
  description,
  onShowAll,
}: {
  description: ActionDescription;
  onShowAll: (input: string) => void;
}) => (
  <dl className="flex flex-col gap-2 text-sm">
    {description.fields.map(({ input, label, value }) => (
      <div className="flex flex-col" key={input}>
        <dt className="text-muted-foreground">{label}</dt>
        <FieldValue
          onShowAll={() => {
            onShowAll(input);
          }}
          value={value}
        />
      </div>
    ))}
  </dl>
);

/**
 * The exact input the write runs with, behind a disclosure: open from the
 * start unless the card already shows all of it (`shown`). `onOpen` says
 * it was opened.
 */
const ExactInput = ({
  input,
  shown,
  onOpen,
}: {
  input: string;
  shown: boolean;
  onOpen: () => void;
}) => {
  const [open, setOpen] = useState(!shown);
  const id = useId();
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        aria-controls={id}
        aria-expanded={open}
        onClick={() => {
          if (!open) {
            onOpen();
          }
          setOpen(!open);
        }}
        size="sm"
        variant="ghost"
      >
        {open ? "Hide" : "Show"} exactly what will be sent
      </Button>
      {open ? (
        <pre
          className="bg-muted w-full overflow-x-auto rounded-md p-3 text-sm"
          id={id}
        >
          <code className="font-mono">{inputOf(input)}</code>
        </pre>
      ) : null}
    </div>
  );
};

const HeldWrite = ({
  action,
  onDecided,
}: {
  action: PendingAction;
  onDecided: () => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  // Read again however it went: a failed decision may have changed
  // something too (the action gone already, say).
  const decide = async (
    decision: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await run(decision);
    onDecided();
  };
  const { description } = action;
  // Confirming is for what the person was shown, all of it: while a value
  // the card cut short hasn't been shown in full, and the exact input
  // hasn't been opened, Confirm waits. The exact input starts open unless
  // the description shows every property of the input.
  const complete = description?.complete === true;
  const [inputSeen, setInputSeen] = useState(!complete);
  const [seen, setSeen] = useState<string[]>([]);
  const unseen =
    !inputSeen &&
    (description?.fields ?? []).some(
      ({ input, value }) =>
        typeof value === "string" && isCutShort(value) && !seen.includes(input)
    );
  const unseenId = useId();
  const title = description?.title ?? action.action;
  const connection = action.connectionName ?? action.connectionId;
  const what = `${title} on ${connection}`;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Waiting for you: {title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            On {connection}
            {action.resource === null ? "" : `, ${action.resource}`}
            {description === undefined ? "" : ` (${action.action})`}
          </p>
          <p className="text-muted-foreground text-sm">
            Asked for{" "}
            <time dateTime={action.requestedAt}>
              {new Date(action.requestedAt).toLocaleString()}
            </time>
          </p>
          {action.restricted ? (
            <Badge variant="destructive">
              This chat read restricted data: this may send it out
            </Badge>
          ) : null}
          {description === undefined ? null : (
            <Described
              description={description}
              onShowAll={(input) => {
                setSeen((shown) => [...shown, input]);
              }}
            />
          )}
          {description?.complete === false ? (
            <p className="text-sm" role="note">
              More will be sent than is shown above. Read exactly what will be
              sent before you confirm.
            </p>
          ) : null}
          <ExactInput
            input={action.input}
            onOpen={() => {
              setInputSeen(true);
            }}
            shown={complete}
          />
          {unseen ? (
            <p className="text-muted-foreground text-sm" id={unseenId}>
              Part of what will be sent is cut short above. Show it all, or
              exactly what will be sent, to confirm.
            </p>
          ) : null}
          <ErrorText>{failure}</ErrorText>
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex gap-2">
          <Button
            aria-describedby={unseen ? unseenId : undefined}
            aria-label={`Confirm ${what}`}
            disabled={busy || unseen}
            onClick={() => {
              void decide(
                async (session) =>
                  await session.pendingActions.confirm(
                    action.id,
                    action.inputHash
                  )
              );
            }}
          >
            Confirm
          </Button>
          <Button
            aria-label={`Reject ${what}`}
            disabled={busy}
            onClick={() => {
              void decide(async (session) => {
                await session.pendingActions.decline(action.id);
              });
            }}
            variant="outline"
          >
            Reject
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
};

/**
 * The chat's held writes, each with confirm and reject. Read again when
 * `version` changes (core says the agent had a write held: `ChatUpdate.held`) and after each
 * decision.
 */
export const HeldWrites = ({
  chatId,
  version,
}: {
  chatId: string;
  version: number;
}) => {
  const [held, setHeld] = useState<Held>({ state: "loading" });
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await readHeld(chatId);
      // A read for another chat, or an older one, doesn't show.
      if (current) {
        setHeld(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `version` and `reads` say when to read again
  }, [chatId, version, reads]);
  if (held.state === "refused") {
    return <ErrorText>{held.message}</ErrorText>;
  }
  if (held.state === "loading" || held.actions.length === 0) {
    return null;
  }
  return (
    <section aria-label="Waiting for you" className="flex flex-col gap-2">
      {held.actions.map((action) => (
        <HeldWrite
          action={action}
          key={action.id}
          onDecided={() => {
            setReads(reads + 1);
          }}
        />
      ))}
    </section>
  );
};
