import type { App, VersionReview } from "@grasp-os/shared/apps";
import { appErrors } from "@grasp-os/shared/apps";
import type { ChatDraft } from "@grasp-os/shared/chat";
import { featureErrors, messageOf } from "@grasp-os/shared/errors";
import { roleErrors } from "@grasp-os/shared/roles";
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
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";

// In the side panel, while the chat's agent builds Apps (`app_builder`):
// the Apps it is still changing in the chat's own drafts, and the Apps the
// person builds with a version up for review, which they review (what
// core says it changes, never the proposer's word) and make current here.
// Functional only.

/** What the panel read: the person's Apps, and the chat's drafts. */
interface Builds {
  apps: App[];
  drafts: ChatDraft[];
}

/**
 * The person's Apps and the chat's drafts; `off` while the agent doesn't
 * build Apps, when the panel shows none of this. Outside the component,
 * as the React Compiler can't compile `try`.
 */
const readBuilds = async (
  chatId: string
): Promise<Loaded<Builds> | { state: "off" }> => {
  try {
    const [apps, drafts] = await withSession(
      async (session) =>
        await Promise.all([session.apps.list(), session.chats.drafts(chatId)])
    );
    return { state: "ready", data: { apps, drafts } };
  } catch (error) {
    if (featureErrors.codeOf(error) === "feature.disabled") {
      return { state: "off" };
    }
    return { state: "refused", message: messageOf(error) };
  }
};

/**
 * A version's review, or `hidden` for an App the person doesn't build:
 * only builders review and make versions current, so they alone see it.
 */
const readReview = async (
  app: string,
  version: number
): Promise<Loaded<VersionReview> | { state: "hidden" }> => {
  try {
    const review = await withSession(
      async (session) => await session.apps.versions.review(app, version)
    );
    return { state: "ready", data: review };
  } catch (error) {
    const hidden =
      roleErrors.codeOf(error) !== undefined ||
      appErrors.codeOf(error) === "app.not_found" ||
      featureErrors.codeOf(error) === "feature.disabled";
    return hidden
      ? { state: "hidden" }
      : { state: "refused", message: messageOf(error) };
  }
};

/** How something changed, as a reviewer reads it. */
const changeWords = {
  added: "Added",
  modified: "Changed",
  removed: "Removed",
} as const;

/** Who proposed a version, as its reviewer reads it. */
const proposerText = ({ proposedBy }: VersionReview): string => {
  if (proposedBy === null) {
    return "Committed by a person.";
  }
  if (!proposedBy.ownChat) {
    return "Proposed by the agent, in another person's chat.";
  }
  return proposedBy.chatTitle === null
    ? "Proposed by the agent, in a chat of yours that was deleted."
    : `Proposed by the agent in chat "${proposedBy.chatTitle}".`;
};

/** One changed file of the server code: before, and as it would run. */
interface ServerFile {
  path: string;
  before?: string;
  after?: string;
}

/**
 * Each changed file of a version's server code (`app/**.ts`), before and
 * after: against the current version, or as a first version has it.
 */
const serverCodeOf = async (
  session: Session,
  {
    app,
    current,
    version,
    serverFiles,
  }: {
    app: string;
    current: number | null;
    version: number;
    serverFiles: VersionReview["serverFiles"];
  }
): Promise<ServerFile[]> => {
  const paths = new Set(serverFiles.map(({ path }) => path));
  if (current === null) {
    const files = await session.apps.files.read(app, version);
    return [...paths].map((path) => ({ path, after: files[path] }));
  }
  const diff = await session.apps.versions.diff(app, current, version);
  return diff
    .filter(({ path }) => paths.has(path))
    .map((file) => ({
      path: file.path,
      ...(file.change === "added" ? {} : { before: file.before }),
      ...(file.change === "deleted" ? {} : { after: file.after }),
    }));
};

/**
 * The server code a version runs, as it changes: it acts for whoever uses
 * the App, with everything the App holds, so it is shown in full.
 */
const ServerCode = ({
  app,
  review,
}: {
  app: string;
  review: VersionReview;
}) => {
  const [code, setCode] = useState<Loaded<ServerFile[]>>();
  const { current, serverFiles } = review;
  const { version } = review.version;
  useEffect(() => {
    let open = true;
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        async (session) =>
          await serverCodeOf(session, { app, current, version, serverFiles })
      );
      if (open) {
        setCode(found);
      }
    };
    void read();
    return () => {
      open = false;
    };
  }, [app, current, version, serverFiles]);
  if (code === undefined) {
    return null;
  }
  if (code.state !== "ready") {
    return <NotLoaded page={code} />;
  }
  return (
    <>
      {code.data.map(({ path, before, after }) => (
        <details key={path}>
          <summary>
            <code className="font-mono">{path}</code>, as it would run
          </summary>
          {before === undefined ? null : (
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
              <code className="font-mono">{before}</code>
            </pre>
          )}
          {after === undefined ? null : (
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
              <code className="font-mono">{after}</code>
            </pre>
          )}
        </details>
      ))}
    </>
  );
};

/** What a version changes, as core worked it out. */
const ReviewDetails = ({
  app,
  review,
}: {
  app: string;
  review: VersionReview;
}) => (
  <div className="flex flex-col gap-3 text-sm">
    <p>{proposerText(review)}</p>
    <blockquote className="border-l-2 pl-3">
      <span className="text-muted-foreground block text-xs">
        In the proposer&apos;s words
      </span>
      {review.version.message}
    </blockquote>
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
    {review.server === null ? null : (
      <section aria-label="Server code" className="flex flex-col gap-1">
        <h4 className="font-medium">Server code</h4>
        <Badge variant="destructive">
          {changeWords[review.server]}: it acts for whoever uses the App, with
          everything the App holds
        </Badge>
        <ServerCode app={app} review={review} />
      </section>
    )}
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
              {workflow.shared.length === 0 ? null : (
                <span className="text-muted-foreground">
                  Code it may use changed: {workflow.shared.join(", ")}
                </span>
              )}
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
                    {step.calls.length === 0 ? null : (
                      <Badge variant="outline">
                        Calls {step.calls.join(", ")}: may change things
                      </Badge>
                    )}
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
    <section aria-label="What the App holds" className="flex flex-col gap-1">
      <h4 className="font-medium">What the App holds</h4>
      {review.grants.length === 0 ? (
        <p className="text-muted-foreground">No permissions.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {review.grants.map(({ permission, askedAgain }) => (
            <li key={permission.id}>
              {permission.binding}: {permission.actions.join(", ")} on{" "}
              {permission.object.type}
              {askedAgain
                ? ", asked for again of an admin if you make this current"
                : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
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
              {permission.requestedVia === null ? "" : " (asked by the agent)"}
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
 * An App's version up for review: what it changes, and making it current;
 * nothing for an App the person doesn't build.
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
  const [review, setReview] = useState<
    Loaded<VersionReview> | { state: "hidden" }
  >();
  const { busy, failure, run } = useCoreAction();
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await readReview(app.id, version);
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
  if (review === undefined || review.state === "hidden") {
    return null;
  }
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          {app.name}: version {version} waiting for review
        </CardTitle>
      </CardHeader>
      <CardContent>
        {review.state === "ready" ? (
          <ReviewDetails app={app.id} review={review.data} />
        ) : (
          <NotLoaded page={review} />
        )}
        <ErrorText>{failure}</ErrorText>
      </CardContent>
      {review.state === "ready" ? (
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
  const [builds, setBuilds] = useState<Loaded<Builds> | { state: "off" }>();
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
  if (builds === undefined || builds.state === "off") {
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
      <h3 className="text-sm font-medium">Being built</h3>
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
