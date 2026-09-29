import type { App, VersionReview } from "@grasp-os/shared/apps";
import type { ChatDraft } from "@grasp-os/shared/chat";
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
import { useEffect, useRef, useState } from "react";

import { withSession } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// In the side panel: the Apps the chat's agent is building. Those it is
// still changing in the chat's own drafts, and the person's Apps with a
// version up for review, which a builder reviews (what core says it
// changes, never the agent's word) and makes current here. Functional
// only.

/** What the panel read: the person's Apps, and the chat's drafts. */
interface Builds {
  apps: App[];
  drafts: ChatDraft[];
}

/**
 * The person's Apps and the chat's drafts. Outside the component, as the
 * React Compiler can't compile `try`. Drafts switched off (`app_builder`)
 * are none, rather than a refusal in every chat's panel.
 */
const readBuilds = async (chatId: string): Promise<Loaded<Builds>> => {
  const apps = await loadFromCore(async (session) => await session.apps.list());
  if (apps.state !== "ready") {
    return apps;
  }
  try {
    const drafts = await withSession(
      async (session) => await session.chats.drafts(chatId)
    );
    return { state: "ready", data: { apps: apps.data, drafts } };
  } catch (error) {
    if (featureErrors.codeOf(error) === "feature.disabled") {
      return { state: "ready", data: { apps: apps.data, drafts: [] } };
    }
    return { state: "refused", message: messageOf(error) };
  }
};

/** How something changed, as a reviewer reads it. */
const changeWords = {
  added: "Added",
  modified: "Changed",
  removed: "Removed",
} as const;

/** What a version changes, as core worked it out. */
const ReviewDetails = ({ review }: { review: VersionReview }) => (
  <div className="flex flex-col gap-3 text-sm">
    <p>{review.version.message}</p>
    <p className="text-muted-foreground">
      {review.current === null
        ? "Nothing runs yet: this would be the App's first current version."
        : `Compared with version ${review.current}, which runs now.`}
    </p>
    <section aria-label="Files" className="flex flex-col gap-1">
      <h4 className="font-medium">Files</h4>
      {review.files.length === 0 ? (
        <p className="text-muted-foreground">No file changes.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {review.files.map(({ path, change }) => (
            <li key={path}>
              {changeWords[change]} <code className="font-mono">{path}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
    {review.workflows.length === 0 ? null : (
      <section aria-label="Workflows" className="flex flex-col gap-1">
        <h4 className="font-medium">Workflows</h4>
        <ul className="flex flex-col gap-2">
          {review.workflows.map((workflow) => (
            <li className="flex flex-col gap-1" key={workflow.id}>
              <span>
                {changeWords[workflow.change]} workflow{" "}
                <code className="font-mono">{workflow.id}</code>
              </span>
              {workflow.steps === null ? (
                <span className="text-muted-foreground">
                  Its steps can&apos;t be read from its code.
                </span>
              ) : (
                workflow.steps.map((step) => (
                  <span className="flex items-center gap-2" key={step.name}>
                    {changeWords[step.change]} step {step.name}
                    {step.sideEffect ? (
                      <Badge variant="destructive">
                        Changes something outside Grasp
                      </Badge>
                    ) : null}
                  </span>
                ))
              )}
              {workflow.params?.map((param) => (
                <span key={param.name}>
                  {changeWords[param.change]} parameter {param.name}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </section>
    )}
    <section aria-label="Permissions asked for" className="flex flex-col gap-1">
      <h4 className="font-medium">Permissions asked for</h4>
      {review.permissions.length === 0 ? (
        <p className="text-muted-foreground">None waiting for an admin.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {review.permissions.map((permission) => (
            <li key={permission.id}>
              {permission.binding}: {permission.actions.join(", ")} on{" "}
              {permission.object.type}, waiting for an admin
            </li>
          ))}
        </ul>
      )}
    </section>
    <section aria-label="Tests" className="flex flex-col gap-1">
      <h4 className="font-medium">Tests</h4>
      <p>
        {review.tests.status === "passed" ? "All workflow tests pass." : null}
        {review.tests.status === "none" ? "No workflows to test." : null}
        {review.tests.status === "failed" ? "Workflow tests fail:" : null}
      </p>
      {review.tests.failures.map((failure) => (
        <p className="text-destructive" key={failure}>
          {failure}
        </p>
      ))}
    </section>
  </div>
);

/**
 * An App's version up for review: what it changes, and making it current,
 * for the App's builders (a person who isn't one reads why not).
 */
const PendingVersion = ({
  app,
  version,
  onDone,
}: {
  app: App;
  version: number;
  onDone: () => void;
}) => {
  const [review, setReview] = useState<Loaded<VersionReview>>();
  const { busy, failure, run } = useCoreAction();
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        async (session) => await session.apps.versions.review(app.id, version)
      );
      if (current) {
        setReview(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [app.id, version]);
  const makeCurrent = async (): Promise<void> => {
    const made = await run(
      async (session) => await session.apps.versions.setCurrent(app.id, version)
    );
    if (made !== undefined) {
      onDone();
    }
  };
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          {app.name}: version {version} waiting for review
        </CardTitle>
      </CardHeader>
      <CardContent>
        {review === undefined ? null : <NotLoaded page={review} />}
        {review?.state === "ready" ? (
          <ReviewDetails review={review.data} />
        ) : null}
        <ErrorText>{failure}</ErrorText>
      </CardContent>
      {review?.state === "ready" ? (
        <CardFooter>
          <Button
            disabled={busy}
            onClick={() => {
              void makeCurrent();
            }}
          >
            Make version {version} current
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
};

/**
 * The Apps being built: the chat's drafts, and versions up for review.
 * Read again whenever the agent stops working (`running` turns false).
 */
export const ChatBuilds = ({
  chatId,
  running,
}: {
  chatId: string;
  running: boolean;
}) => {
  const [builds, setBuilds] = useState<Loaded<Builds>>();
  const [reads, setReads] = useState(0);
  // Only the latest read shows, whichever ends last.
  const latest = useRef(0);
  useEffect(() => {
    if (running) {
      return;
    }
    latest.current += 1;
    const read = latest.current;
    const load = async (): Promise<void> => {
      const found = await readBuilds(chatId);
      if (latest.current === read) {
        setBuilds(found);
      }
    };
    void load();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reads` says when to read again
  }, [chatId, running, reads]);
  if (builds === undefined) {
    return null;
  }
  if (builds.state !== "ready") {
    return <NotLoaded page={builds} />;
  }
  const names = new Map<string, string>(
    builds.data.apps.map((app) => [app.id, app.name])
  );
  const pending = builds.data.apps.filter(
    ({ pendingVersion }) => pendingVersion !== null
  );
  if (builds.data.drafts.length === 0 && pending.length === 0) {
    return null;
  }
  return (
    <section aria-label="Being built" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Being built</h2>
      {builds.data.drafts.map((draft) => (
        <p className="text-sm" key={draft.app}>
          {names.get(draft.app) ?? draft.app}: {draft.changed.length}{" "}
          {draft.changed.length === 1 ? "file" : "files"} changed in this chat,
          not proposed yet
        </p>
      ))}
      {pending.map((app) =>
        app.pendingVersion === null ? null : (
          <PendingVersion
            app={app}
            key={`${app.id}:${app.pendingVersion}`}
            onDone={() => {
              setReads(reads + 1);
            }}
            version={app.pendingVersion}
          />
        )
      )}
    </section>
  );
};
