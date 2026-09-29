import type { Notification } from "@grasp-os/shared/notifications";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { dateTime } from "../workflows/runs.tsx";

// What core told the person: the workflows that failed while acting for
// them, each with a way to the workflow, and to a new chat that asks the
// agent to fix it, the run's failure report attached. Opening the page
// reads them all; the nav's count goes with it.

interface NotificationsPage {
  notifications: Notification[];
  /**
   * The model a fix is asked with: the deployment's default; none while
   * chats are off, or no model is set up, and nobody is offered to ask.
   */
  model: string | undefined;
}

/** The person's notifications, marked read once listed. */
const readNotifications = async (
  session: Session
): Promise<NotificationsPage> => {
  const [{ notifications, unread }, models] = await Promise.all([
    session.notifications.list(),
    listedOrNone(session.chats.models()),
  ]);
  const [newest] = notifications;
  if (unread > 0 && newest !== undefined) {
    await session.notifications.markRead(
      notifications.map(({ id }) => id),
      newest.at
    );
  }
  return { notifications, model: models[0] };
};

/** Starts a chat that asks the agent to fix `run`, and opens it. */
const AskToFix = ({ run, model }: { run: string; model: string }) => {
  const navigate = useNavigate();
  const { busy, failure, run: act } = useCoreAction();
  const ask = async (): Promise<void> => {
    const chat = await act(
      async (session) => await session.chats.fixRun(run, model)
    );
    if (chat !== undefined) {
      await navigate({ to: "/", search: { chat: chat.id } });
    }
  };
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

const NotificationList = ({ page }: { page: NotificationsPage }) =>
  page.notifications.length === 0 ? (
    <p className="text-muted-foreground text-sm">
      Nothing yet. When a workflow fails while acting for you, you&apos;ll see
      it here.
    </p>
  ) : (
    <ul aria-label="Notifications" className="flex flex-col gap-2">
      {page.notifications.map((notification) => (
        <FailedWorkflow
          key={notification.id}
          model={page.model}
          notification={notification}
        />
      ))}
    </ul>
  );

export const Route = createFileRoute("/_shell/notifications")({
  loader: async () => await loadFromCore(readNotifications),
  component: Notifications,
});
