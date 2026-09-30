import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { useState } from "react";

import { ask, refusal } from "./intake";
import type { GuestChat, Invited } from "./intake";
import { whilePending } from "./pending";

/** How each chat's state reads. */
const statusLabels: Record<GuestChat["status"], string> = {
  open: "open",
  finished: "finished",
  revoked: "revoked",
  expired: "expired",
};

/** Longest name of someone invited. */
const nameMax = 100;

/** The link of a chat just made: shown once, as core keeps no copy. */
const NewLink = ({ invited }: { invited: Invited }) => (
  <div className="flex flex-col gap-1">
    <p className="text-sm">
      Send this link to {invited.name} yourself. It works for them only, until{" "}
      {new Date(invited.expiresAt).toLocaleDateString()}, and isn&apos;t shown
      again: if it gets lost, revoke the chat and invite them again.
    </p>
    <Input
      aria-label={`Link for ${invited.name}`}
      readOnly
      value={invited.link}
      onFocus={(event) => {
        event.target.select();
      }}
    />
  </div>
);

/**
 * Stakeholder chats: inviting someone on the team to a short chat about
 * their work by link, and, once they wrote, taking the statements out of
 * what they wrote (`onRead`), as a draft to review.
 */
export const Stakeholders = ({
  chats,
  onChanged,
  onRead,
}: {
  chats: GuestChat[];
  /** Lists the chats again, after one was made or revoked. */
  onChanged: () => Promise<void>;
  onRead: (chat: GuestChat) => void;
}) => {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [invited, setInvited] = useState<Invited | null>(null);

  const invite = async (): Promise<void> => {
    const answer = await whilePending(
      setBusy,
      async () => await ask<Invited>("invite", { name: name.trim() })
    );
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    setName("");
    setInvited(answer.ok);
    await onChanged();
  };

  const revoke = async (chat: GuestChat): Promise<void> => {
    const answer = await whilePending(
      setBusy,
      async () => await ask<GuestChat>("revokeChat", chat.id)
    );
    if ("error" in answer) {
      setProblem(refusal(answer.error));
      return;
    }
    setProblem("");
    if (invited?.id === chat.id) {
      setInvited(null);
    }
    await onChanged();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Stakeholder chats</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            Invite someone on the team to a short chat about their work. They
            need no account: a link is all they get, and all they reach. What
            they write is theirs to say, not ours to trust: review every
            statement taken from it.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Name"
              placeholder="Their name"
              className="w-auto grow"
              maxLength={nameMax}
              value={name}
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
            <Button
              disabled={busy || name.trim() === ""}
              onClick={() => {
                void invite();
              }}
            >
              Invite
            </Button>
          </div>
          {invited === null ? null : <NewLink invited={invited} />}
          {problem === "" ? null : (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
          {chats.length === 0 ? null : (
            <Table aria-label="Stakeholder chats">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {chats.map((chat) => (
                  <TableRow key={chat.id}>
                    <TableCell>{chat.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {statusLabels[chat.status]}
                      </Badge>
                    </TableCell>
                    <TableCell>{chat.turns}</TableCell>
                    <TableCell>
                      <div className="flex gap-2">
                        {chat.turns > 0 ? (
                          <Button
                            variant="outline"
                            disabled={busy}
                            aria-label={`Take out statements from ${chat.name}`}
                            onClick={() => {
                              onRead(chat);
                            }}
                          >
                            Take out statements
                          </Button>
                        ) : null}
                        {chat.status === "revoked" ? null : (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            aria-label={`Revoke ${chat.name}'s link`}
                            onClick={() => {
                              void revoke(chat);
                            }}
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
    </Card>
  );
};
