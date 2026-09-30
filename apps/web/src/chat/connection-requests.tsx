import type { ChatConnectionRequest } from "@grasp-os/shared/chat";
import { messageOf } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// The connections the chat's agent asked to use in this chat (core's
// chat-connections.ts), each on a card: the person grants or denies their
// own personal connection here; a shared one waits for an admin, and they
// may withdraw it. The card shows the request exactly as stored, and
// granting names only its ID: what is granted is what it shows.

/** What the page read of the chat's requests. */
type Requests =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; requests: ChatConnectionRequest[] };

/** The chat's requests. Outside the component, as the React Compiler can't compile `try`. */
const readRequests = async (
  core: CoreConnection,
  chatId: string
): Promise<Requests> => {
  try {
    const requests = await core.withSession(
      async (session) => await session.chats.connectionRequests(chatId)
    );
    return { state: "ready", requests };
  } catch (error) {
    return { state: "refused", message: messageOf(error) };
  }
};

const ConnectionRequest = ({
  chatId,
  request,
  onDecided,
}: {
  chatId: string;
  request: ChatConnectionRequest;
  onDecided: () => void;
}) => {
  const { busy, failure, run } = useCoreAction();
  // Read again however it went: a failed decision may have changed
  // something too (decided elsewhere, say).
  const decide = async (
    decision: (session: Session) => Promise<unknown>
  ): Promise<void> => {
    await run(decision);
    onDecided();
  };
  const connection = [request.provider, request.accountName]
    .filter((part) => part !== null)
    .join(", ");
  const name = connection === "" ? request.connectionId : connection;
  const yours = request.decidedBy === "you";
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          {yours
            ? `The agent asks to use ${name}`
            : `The agent asked an admin for ${name}`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2 text-sm">
          {request.reason === null ? null : (
            <p className="break-words whitespace-pre-wrap">{request.reason}</p>
          )}
          <dl className="flex flex-col gap-2">
            <div className="flex flex-col">
              <dt className="text-muted-foreground">It may</dt>
              <dd className="font-mono">{request.actions.join(", ")}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-muted-foreground">As</dt>
              <dd className="font-mono">{request.binding}</dd>
            </div>
            {request.resource === null ? null : (
              <div className="flex flex-col">
                <dt className="text-muted-foreground">Only</dt>
                <dd className="break-words">{request.resource}</dd>
              </div>
            )}
          </dl>
          <p className="text-muted-foreground">
            {yours
              ? "In this chat only, until you delete it. Anything it sends or changes still waits for you to confirm."
              : "An admin decides. It holds in this chat only."}
          </p>
          <ErrorText>{failure}</ErrorText>
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex gap-2">
          {yours ? (
            <Button
              aria-label={`Grant ${name}`}
              disabled={busy}
              onClick={() => {
                void decide(async (session) => {
                  await session.chats.grantConnection(chatId, request.id);
                });
              }}
            >
              Grant
            </Button>
          ) : null}
          <Button
            aria-label={`${yours ? "Deny" : "Withdraw"} ${name}`}
            disabled={busy}
            onClick={() => {
              void decide(async (session) => {
                await session.chats.denyConnection(chatId, request.id);
              });
            }}
            variant="outline"
          >
            {yours ? "Deny" : "Withdraw"}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
};

/**
 * The chat's connection requests, each with its decision. Read again when
 * `version` changes (`ChatUpdate.held`: something waits, or no longer
 * does) and after each decision.
 */
export const ConnectionRequests = ({
  chatId,
  version,
}: {
  chatId: string;
  version: number;
}) => {
  const [read, setRead] = useState<Requests>({ state: "loading" });
  const core = useCore();
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const found = await readRequests(core, chatId);
      // A read for another chat, or an older one, doesn't show.
      if (current) {
        setRead(found);
      }
    };
    void load();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `version` and `reads` say when to read again
  }, [core, chatId, version, reads]);
  if (read.state === "refused") {
    return <ErrorText>{read.message}</ErrorText>;
  }
  if (read.state === "loading" || read.requests.length === 0) {
    return null;
  }
  return (
    <section aria-label="Connection requests" className="flex flex-col gap-2">
      {read.requests.map((request) => (
        <ConnectionRequest
          chatId={chatId}
          key={request.id}
          onDecided={() => {
            setReads(reads + 1);
          }}
          request={request}
        />
      ))}
    </section>
  );
};
