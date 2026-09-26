import type { DecisionView } from "@grasp-os/shared/decisions";
import { messageOf } from "@grasp-os/shared/errors";
import type { SignInOption } from "@grasp-os/shared/rpc";
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
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { loadCoreStatus, signIn, withSession } from "../core.ts";

// Where a decision link leads (`/decisions/<id>?link=<token>`). Opening it
// answers nothing (threat model R8): the person signs in, sees what is
// asked, and answers with a button. Core checks on every call that they
// may answer, and that the link is theirs; this page only shows what core
// says. The link works for nobody but the person it was sent to.

type DecisionPage =
  | { state: "offline" }
  | { state: "signed-out"; signInOptions: SignInOption[] }
  | { state: "refused"; name: string; message: string }
  | { state: "ready"; name: string; decision: DecisionView };

const loadDecision = async (
  decision: string,
  link: string | undefined
): Promise<DecisionPage> => {
  const { connected, signInOptions, identity } = await loadCoreStatus();
  if (!connected) {
    return { state: "offline" };
  }
  if (identity === undefined) {
    return { state: "signed-out", signInOptions };
  }
  try {
    const found = await withSession(
      async (session) => await session.decisions.get(decision, link)
    );
    return { state: "ready", name: identity.name, decision: found };
  } catch (error) {
    return { state: "refused", name: identity.name, message: messageOf(error) };
  }
};

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** How a decision that is no longer open ended. */
const outcomeOf = (decision: DecisionView): string => {
  const { decided } = decision;
  if (decision.status === "timed_out" || decided === undefined) {
    return "Nobody answered in time, so this decision has closed.";
  }
  const answer = decision.status === "approved" ? "Approved" : "Rejected";
  return `${answer} by ${decided.by.name} on ${dateTime.format(new Date(decided.at))}.`;
};

const Answer = ({
  decision,
  link,
}: {
  decision: DecisionView;
  link: string | undefined;
}) => {
  const [current, setCurrent] = useState(decision);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const answer = async (approved: boolean): Promise<void> => {
    setBusy(true);
    setFailure(undefined);
    const note = comment.trim();
    try {
      const answered = await withSession(
        async (session) =>
          await session.decisions.answer(
            current.id,
            note === ""
              ? { approved }
              : { approved, payload: { comment: note } },
            link
          )
      );
      setCurrent(answered);
    } catch (error) {
      setFailure(messageOf(error));
    }
    setBusy(false);
  };
  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>
          <h1>{current.description}</h1>
        </CardTitle>
        <CardDescription>
          Asked by {current.app.name} ({current.workflow})
          {current.status === "open"
            ? `, open until ${dateTime.format(new Date(current.expiresAt))}`
            : ""}
        </CardDescription>
      </CardHeader>
      {current.status === "open" ? (
        <>
          <CardContent>
            <div className="flex flex-col gap-2">
              <label className="text-sm" htmlFor="decision-comment">
                Comment (optional)
              </label>
              <Textarea
                id="decision-comment"
                value={comment}
                maxLength={2000}
                disabled={busy}
                onChange={(event) => {
                  setComment(event.target.value);
                }}
              />
              {failure === undefined ? null : (
                <p className="text-destructive text-sm" role="alert">
                  {failure}
                </p>
              )}
            </div>
          </CardContent>
          <CardFooter>
            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() => {
                  void answer(true);
                }}
              >
                Approve
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void answer(false);
                }}
              >
                Reject
              </Button>
            </div>
          </CardFooter>
        </>
      ) : (
        <CardContent>
          <output className="text-sm">{outcomeOf(current)}</output>
        </CardContent>
      )}
    </Card>
  );
};

const Decision = () => {
  const page = Route.useLoaderData();
  const { link } = Route.useSearch();
  if (page.state === "offline") {
    return (
      <main className="flex min-h-svh items-center justify-center p-6">
        <p className="text-destructive text-sm" role="alert">
          Grasp can&apos;t be reached right now. Try again in a moment.
        </p>
      </main>
    );
  }
  if (page.state === "signed-out") {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
        <h1 className="text-2xl font-medium">Sign in to answer</h1>
        <p className="text-muted-foreground text-sm">
          Only the person this was sent to can answer it.
        </p>
        {page.signInOptions.map(({ providerId, label }) => (
          <Button
            key={providerId}
            onClick={() => {
              void signIn(
                providerId,
                `${window.location.pathname}${window.location.search}`
              );
            }}
          >
            Sign in with {label}
          </Button>
        ))}
      </main>
    );
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <p className="text-muted-foreground text-sm">Signed in as {page.name}</p>
      {page.state === "refused" ? (
        <p className="text-destructive text-sm" role="alert">
          {page.message}
        </p>
      ) : (
        <Answer decision={page.decision} link={link} />
      )}
    </main>
  );
};

export const Route = createFileRoute("/decisions/$decision")({
  component: Decision,
  validateSearch: (search: Record<string, unknown>): { link?: string } =>
    typeof search.link === "string" ? { link: search.link } : {},
  loaderDeps: ({ search: { link } }) => ({ link }),
  loader: async ({ params, deps }) =>
    await loadDecision(params.decision, deps.link),
});
