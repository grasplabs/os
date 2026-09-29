import type {
  Notification,
  NotificationCursor,
  NotificationPage,
} from "@grasp-os/shared/notifications";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { dateTime } from "../workflows/runs.tsx";

// What core told the person: the workflows that failed while acting for
// them, each with a way to the workflow, and to a new chat that asks the
// agent to fix it, the run's failure report attached. The latest page
// shows first, and older ones on asking; each page is marked read as it
// shows, and the nav's count goes with it.

interface NotificationsPage {
  page: NotificationPage;
  /**
   * The model a fix is asked with: the deployment's default; none while
   * chats are off, or no model is set up, and nobody is offered to ask.
   */
  model: string | undefined;
}

/**
 * A page of the person's notifications (the latest, or those older than
 * `before`), marked read as shown: only its unread ones, only as they
 * were when listed.
 */
const readPage = async (
  session: Session,
  before?: NotificationCursor
): Promise<NotificationPage> => {
  const page = await session.notifications.list(before);
  const unread = page.notifications.filter(({ read }) => !read);
  const [newest] = page.notifications;
  if (unread.length > 0 && newest !== undefined) {
    await session.notifications.markRead(
      unread.map(({ id }) => id),
      newest.at
    );
  }
  return page;
};

/** The latest page, and the model to ask a fix with. */
const readNotifications = async (
  session: Session
): Promise<NotificationsPage> => {
  const [page, models] = await Promise.all([
    readPage(session),
    listedOrNone(session.chats.models()),
  ]);
  return { page, model: models[0] };
};

/**
 * Starts a chat that asks the agent to fix `run`, and opens it. A chat
 * made whose question was refused is offered to open, with why, instead
 * of the button: asking again would make another.
 */
const AskToFix = ({ run, model }: { run: string; model: string }) => {
  const navigate = useNavigate();
  const { busy, failure, run: act } = useCoreAction();
  const [refused, setRefused] = useState<{ chat: string; reason: string }>();
  const ask = async (): Promise<void> => {
    const started = await act(
      async (session) => await session.chats.fixRun(run, model)
    );
    if (started === undefined) {
      return;
    }
    if (started.sent) {
      await navigate({ to: "/", search: { chat: started.chat.id } });
      return;
    }
    setRefused({ chat: started.chat.id, reason: started.reason });
  };
  if (refused !== undefined) {
    return (
      <div className="flex flex-col gap-1">
        <Link
          className={buttonVariants({ size: "sm", variant: "outline" })}
          search={{ chat: refused.chat }}
          to="/"
        >
          Open the chat
        </Link>
        <ErrorText>{`The agent wasn't asked: ${refused.reason}`}</ErrorText>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Button
        disabled={busy}
        onClick={() => {
          void ask();
        }}
        size="sm"
      >
        Ask the agent to fix
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** One notification: which workflow failed, how often, and when last. */
const FailedWorkflow = ({
  notification,
  model,
}: {
  notification: Notification;
  model: string | undefined;
}) => {
  const { app, appName, workflow, run, failures, at, read } = notification;
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-md border p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex items-center gap-2 text-sm">
          {read ? null : <Badge>New</Badge>}
          <span>
            <Link
              className="underline"
              params={{ app, workflow }}
              to="/workflows/$app/$workflow"
            >
              {workflow}
            </Link>
            {` in ${appName} failed`}
            {failures > 1 ? ` ${failures} times` : ""}
          </span>
        </p>
        <p className="text-muted-foreground text-xs">
          {`Last on ${dateTime.format(new Date(at))}`}
        </p>
      </div>
      {model === undefined ? null : <AskToFix model={model} run={run} />}
    </li>
  );
};

const Notifications = () => {
  const page = Route.useLoaderData();
  return (
    <main className="flex max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-medium">Notifications</h1>
      {page.state === "ready" ? (
        <NotificationList page={page.data} />
      ) : (
        <NotLoaded page={page} />
      )}
    </main>
  );
};

/** The pages shown so far, and the way to the next older one. */
const NotificationList = ({ page }: { page: NotificationsPage }) => {
  const [shown, setShown] = useState(page.page.notifications);
  const [more, setMore] = useState(page.page.more);
  const { busy, failure, run } = useCoreAction();
  const showOlder = async (): Promise<void> => {
    const last = shown.at(-1);
    if (last === undefined) {
      return;
    }
    const next = await run(
      async (session) => await readPage(session, { at: last.at, id: last.id })
    );
    if (next !== undefined) {
      setShown([...shown, ...next.notifications]);
      setMore(next.more);
    }
  };
  if (shown.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing yet. When a workflow fails while acting for you, you&apos;ll see
        it here.
      </p>
    );
  }
  return (
    <>
      <ul aria-label="Notifications" className="flex flex-col gap-2">
        {shown.map((notification) => (
          <FailedWorkflow
            key={notification.id}
            model={page.model}
            notification={notification}
          />
        ))}
      </ul>
      {more ? (
        <Button
          className="self-start"
          disabled={busy}
          onClick={() => {
            void showOlder();
          }}
          variant="outline"
        >
          Show older
        </Button>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

export const Route = createFileRoute("/_shell/notifications")({
  loader: async () => await loadFromCore(readNotifications),
  component: Notifications,
});
