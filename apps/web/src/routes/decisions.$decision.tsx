import type { DecisionView } from "@grasp-os/shared/decisions";
import { failureText } from "@grasp-os/shared/errors";
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
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { loadCoreStatus, readWithin } from "../core-connection.ts";
import type { CoreConnection } from "../core-connection.ts";
import { CoreTimeoutError } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";
import { SignInOptions } from "../sign-in-options.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Where a decision link leads (`/decisions/<id>`). Opening it answers
// nothing (threat model R8): the person signs in, sees what is asked, and
// answers with a button. Core checks on every call that they may answer;
// this page only shows what core says.

type DecisionPage =
  | { state: "offline" }
  | { state: "signed-out"; signInOptions: SignInOption[] }
  | { state: "refused"; name: string; message: string }
  | { state: "ready"; name: string; decision: DecisionView };

const loadDecision = async (
  core: CoreConnection,
  decision: string
): Promise<DecisionPage> => {
  const { connected, signInOptions, identity } = await loadCoreStatus(core);
  if (!connected) {
    return { state: "offline" };
  }
  if (identity === undefined) {
    return { state: "signed-out", signInOptions };
  }
  try {
    // A connection that answered the status check can still hang here.
    const found = await readWithin(
      core,
      async (session) => await session.decisions.get(decision)
    );
    return { state: "ready", name: identity.name, decision: found };
  } catch (error) {
    if (error instanceof CoreTimeoutError) {
      return { state: "offline" };
    }
    return {
      state: "refused",
      name: identity.name,
      message: failureText(error),
    };
  }
};

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** How a decision that is no longer open ended. */
const outcomeOf = (decision: DecisionView): string => {
  const { decided } = decision;
  // `closed` is only ever an open decision whose run has ended.
  if (decision.status === "closed") {
    return i18n._(
      msg`The workflow run that asked this has ended, so this decision has closed.`
    );
  }
  if (decision.status === "timed_out" || decided === undefined) {
    return i18n._(msg`Nobody answered in time, so this decision has closed.`);
  }
  const { name } = decided.by;
  const date = dateTime.format(new Date(decided.at));
  return decision.status === "approved"
    ? i18n._(msg`Approved by ${name} on ${date}.`)
    : i18n._(msg`Rejected by ${name} on ${date}.`);
};

const Answer = ({ decision }: { decision: DecisionView }) => {
  const [current, setCurrent] = useState(decision);
  const [comment, setComment] = useState("");
  const { busy, failure, run } = useCoreAction();
  const { t } = useLingui();
  const app = current.app.name;
  const { workflow } = current;
  const until = dateTime.format(new Date(current.expiresAt));
  const answer = async (approved: boolean): Promise<void> => {
    const note = comment.trim();
    const answered = await run(
      async (session) =>
        await session.decisions.answer(
          current.id,
          note === "" ? { approved } : { approved, payload: { comment: note } }
        )
    );
    if (answered !== undefined) {
      setCurrent(answered);
    }
  };
  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>
          <h1>{current.description}</h1>
        </CardTitle>
        <CardDescription>
          {current.status === "open"
            ? t`Asked by ${app} (${workflow}), open until ${until}`
            : t`Asked by ${app} (${workflow})`}
        </CardDescription>
      </CardHeader>
      {current.status === "open" ? (
        <>
          <CardContent>
            <div className="flex flex-col gap-2">
              <label className="text-sm" htmlFor="decision-comment">
                <Trans>Comment (optional)</Trans>
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
              <ErrorText>{failure}</ErrorText>
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
                <Trans>Approve</Trans>
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  void answer(false);
                }}
              >
                <Trans>Reject</Trans>
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
  const { error } = Route.useSearch();
  const { t } = useLingui();
  if (page.state === "offline") {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
        <h1 className="text-2xl font-medium">
          <Trans>Decision</Trans>
        </h1>
        <ErrorText>
          {t`Grasp can't be reached right now. Try again in a moment.`}
        </ErrorText>
      </main>
    );
  }
  if (page.state === "signed-out") {
    return (
      <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
        <h1 className="text-2xl font-medium">
          <Trans>Sign in to answer</Trans>
        </h1>
        <p className="text-muted-foreground text-sm">
          <Trans>Only the people this decision is from can answer it.</Trans>
        </p>
        <SignInOptions
          options={page.signInOptions}
          error={error}
          // Back to this page, without an earlier error.
          returnTo={window.location.pathname}
        />
      </main>
    );
  }
  const { name } = page;
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <p className="text-muted-foreground text-sm">
        <Trans>Signed in as {name}</Trans>
      </p>
      {page.state === "refused" ? (
        <>
          <h1 className="text-2xl font-medium">
            <Trans>Decision</Trans>
          </h1>
          <ErrorText>{page.message}</ErrorText>
        </>
      ) : (
        <Answer decision={page.decision} />
      )}
    </main>
  );
};

export const Route = createFileRoute("/decisions/$decision")({
  component: Decision,
  // A refused sign-in comes back as `error=<code>`.
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    signInErrorSearch(search),
  loader: async ({ context: { core }, params }) =>
    await loadDecision(core, params.decision),
});
