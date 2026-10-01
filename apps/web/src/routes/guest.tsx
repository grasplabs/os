import { guestMessageMaxLength } from "@grasp-os/shared/guests";
import type { GuestView } from "@grasp-os/shared/guests";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { guestCall, linkSecret } from "../guest/api.ts";

// Where a guest link leads (`/guest#<secret>`): someone who isn't a member,
// invited to a short chat about their work. No sign-in, no session: the
// secret after the `#`, which the browser never sends anywhere but in the
// requests below, is all the page has, and all it can do is this chat.
// What the model answers is shown as plain text.

/** What the page shows, and the link's secret it was opened with. */
type Page =
  | { state: "loading"; secret: string }
  | { state: "refused"; secret: string; message: string }
  | { state: "ready"; secret: string; view: GuestView };

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** What the chat says once it can take no more. */
const endedText = (view: GuestView): string | undefined => {
  switch (view.status) {
    case "finished": {
      return i18n._(msg`You finished this chat. Thank you for your time.`);
    }
    case "revoked": {
      return i18n._(
        msg`This chat has been closed by whoever sent you the link.`
      );
    }
    case "expired": {
      return i18n._(
        msg`This link has expired. Ask whoever sent it for a new one.`
      );
    }
    case "open": {
      return view.turnsLeft === 0
        ? i18n._(msg`This chat has reached its length. Press Finish to end it.`)
        : undefined;
    }
    default: {
      return view.status satisfies never;
    }
  }
};

/** The messages so far: theirs, and the answers. */
const Messages = ({ view }: { view: GuestView }) => {
  const { t } = useLingui();
  return (
    <ol aria-label={t`Messages`} className="flex flex-col gap-3">
      {view.messages.map((message) => (
        <li
          key={`${message.at}-${message.role}`}
          className={
            message.role === "guest"
              ? "bg-muted self-end rounded-lg p-3 text-sm whitespace-pre-wrap"
              : "self-start text-sm whitespace-pre-wrap"
          }
        >
          <span className="sr-only">
            {message.role === "guest" ? t`You:` : "Grasp:"}{" "}
          </span>
          {message.text}
        </li>
      ))}
    </ol>
  );
};

/**
 * The chat `secret` opened, open for the guest's next message until it
 * ends. Every message and the finish go with that same secret, never
 * with whatever the URL holds by then.
 */
const Chat = ({ secret, first }: { secret: string; first: GuestView }) => {
  const [view, setView] = useState(first);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const ended = endedText(view);
  const open = view.status === "open";
  const { t } = useLingui();
  const { name } = view;
  const until = dateTime.format(new Date(view.expiresAt));

  const call = async (
    request: { action: "send"; text: string } | { action: "finish" }
  ): Promise<boolean> => {
    setBusy(true);
    const answer = await guestCall({ ...request, token: secret });
    setBusy(false);
    if ("error" in answer) {
      setFailure(answer.error);
      return false;
    }
    setFailure(undefined);
    setView(answer.ok);
    return true;
  };

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>
          <h1>
            <Trans>Hi {name}</Trans>
          </h1>
        </CardTitle>
        <CardDescription>
          <Trans>
            This chat asks how your work is done. Everything you write is kept
            and read by the people who invited you, who may copy it into their
            own records and keep it there. Please don&apos;t share passwords,
            bank details or anything you wouldn&apos;t put in an email.
          </Trans>
          {open ? ` ${t`The link works until ${until}.`}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <Messages view={view} />
          {ended === undefined ? null : (
            <output className="text-sm">{ended}</output>
          )}
          {open && view.turnsLeft > 0 ? (
            <div className="flex flex-col gap-2">
              <label className="text-sm" htmlFor="guest-message">
                <Trans>Your message</Trans>
              </label>
              <Textarea
                id="guest-message"
                value={text}
                maxLength={guestMessageMaxLength}
                disabled={busy}
                onChange={(event) => {
                  setText(event.target.value);
                }}
              />
            </div>
          ) : null}
          <ErrorText>{failure}</ErrorText>
        </div>
      </CardContent>
      {open ? (
        <CardFooter>
          <div className="flex gap-2">
            {view.turnsLeft > 0 ? (
              <Button
                disabled={busy || text.trim() === ""}
                onClick={() => {
                  void (async () => {
                    if (await call({ action: "send", text })) {
                      setText("");
                    }
                  })();
                }}
              >
                <Trans>Send</Trans>
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void call({ action: "finish" });
              }}
            >
              <Trans>Finish</Trans>
            </Button>
          </div>
        </CardFooter>
      ) : null}
    </Card>
  );
};

const Guest = () => {
  // The link's secret, read from the URL once, and again only when the
  // URL's fragment changes (another link pasted over this one): the chat
  // shown, and the one every message goes to, are the one this opened.
  const [secret, setSecret] = useState(linkSecret);
  const [page, setPage] = useState<Page>({ state: "loading", secret });
  useEffect(() => {
    const changed = (): void => {
      setSecret(linkSecret());
    };
    window.addEventListener("hashchange", changed);
    return () => {
      window.removeEventListener("hashchange", changed);
    };
  }, []);
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const answer =
        secret === ""
          ? {
              error: i18n._(
                msg`This link doesn't work. Ask whoever sent it for a new one.`
              ),
            }
          : await guestCall({ action: "open", token: secret });
      if (!current) {
        return;
      }
      setPage(
        "error" in answer
          ? { state: "refused", secret, message: answer.error }
          : { state: "ready", secret, view: answer.ok }
      );
    };
    void load();
    return () => {
      current = false;
    };
  }, [secret]);
  // What was opened with another secret is never shown for this one.
  const shown: Page =
    page.secret === secret ? page : { state: "loading", secret };
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      {shown.state === "loading" ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Opening the chat…</Trans>
        </p>
      ) : null}
      {shown.state === "refused" ? (
        <>
          <h1 className="text-2xl font-medium">
            <Trans>Chat</Trans>
          </h1>
          <ErrorText>{shown.message}</ErrorText>
        </>
      ) : null}
      {shown.state === "ready" ? (
        <Chat key={shown.secret} secret={shown.secret} first={shown.view} />
      ) : null}
    </main>
  );
};

export const Route = createFileRoute("/guest")({ component: Guest });
