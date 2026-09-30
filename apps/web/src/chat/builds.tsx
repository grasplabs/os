import type { App, VersionReview } from "@grasp-os/shared/apps";
import { appErrors } from "@grasp-os/shared/apps";
import type { ChatDraft } from "@grasp-os/shared/chat";
import { failureText } from "@grasp-os/shared/errors";
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

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { PreviewFrame } from "../screens/screen-frame.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import {
  exportChangeText,
  pendingToShow,
  readyToMakeCurrent,
  triggerChangeText,
  stillMadeCurrent,
  serverFileLabels,
  serverFileOf,
  versionKey,
  changedScreens,
  previewedScreen,
} from "./builds-state.ts";
import type { ServerFile } from "./builds-state.ts";

// In the side panel, while the chat's agent builds Apps (`app_builder`):
// the Apps it is still changing in the chat's own drafts, and the Apps the
// person builds with a version up for review, which they review (what
// core says it changes, never the proposer's word) and make current here.
// The draft written last (or the one the person picks) runs as a preview
// (`app_preview`), whose server code changes nothing and reads no real
// data; what goes wrong in it goes to the agent's next check of the draft.
// Functional only.

/** What the panel read: the person's Apps, and the chat's drafts. */
interface Builds {
  apps: App[];
  drafts: ChatDraft[];
}

/**
 * The person's Apps and the chat's drafts. Outside the component, as the
 * React Compiler can't compile `try`.
 */
const readBuilds = async (
  core: CoreConnection,
  chatId: string
): Promise<Loaded<Builds>> => {
  try {
    const [apps, drafts] = await core.withSession(
      async (session) =>
        await Promise.all([session.apps.list(), session.chats.drafts(chatId)])
    );
    return { state: "ready", data: { apps, drafts } };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/**
 * A version's review, or `hidden` for an App the person doesn't build:
 * only builders review and make versions current, so they alone see it.
 */
const readReview = async (
  core: CoreConnection,
  app: string,
  version: number
): Promise<Loaded<VersionReview> | { state: "hidden" }> => {
  try {
    const review = await core.withSession(
      async (session) => await session.apps.versions.review(app, version)
    );
    return { state: "ready", data: review };
  } catch (error) {
    const hidden =
      roleErrors.codeOf(error) !== undefined ||
      appErrors.codeOf(error) === "app.not_found";
    return hidden
      ? { state: "hidden" }
      : { state: "refused", message: failureText(error) };
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
  return diff.filter(({ path }) => paths.has(path)).map(serverFileOf);
};

/**
 * The server code a version runs, as it changes: it acts for whoever uses
 * the App, with everything the App holds, so it is shown in full, what
 * runs now and what would after approval, each labelled.
 */
const ServerCode = ({
  code,
  onRetry,
}: {
  code: Loaded<ServerFile[]> | undefined;
  onRetry: () => void;
}) => {
  if (code === undefined) {
    return (
      <output className="text-muted-foreground">
        Loading the server code…
      </output>
    );
  }
  if (code.state !== "ready") {
    return (
      <div className="flex items-center gap-2">
        <NotLoaded page={code} />
        <Button onClick={onRetry} size="sm" variant="outline">
          Load the server code again
        </Button>
      </div>
    );
  }
  return (
    <>
      {code.data.map((file) => {
        const labels = serverFileLabels(file);
        return (
          <details key={file.path}>
            <summary>{labels.summary}</summary>
            {file.before === undefined ? null : (
              <figure className="flex flex-col gap-1">
                <figcaption className="text-xs">{labels.before}</figcaption>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  <code className="font-mono">{file.before}</code>
                </pre>
              </figure>
            )}
            {file.after === undefined ? null : (
              <figure className="flex flex-col gap-1">
                <figcaption className="text-xs">{labels.after}</figcaption>
                <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs">
                  <code className="font-mono">{file.after}</code>
                </pre>
              </figure>
            )}
          </details>
        );
      })}
    </>
  );
};

/** What a version changes, as core worked it out. */
const ReviewDetails = ({
  review,
  serverCode,
  onRetryServerCode,
}: {
  review: VersionReview;
  serverCode: Loaded<ServerFile[]> | undefined;
  onRetryServerCode: () => void;
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
        <ServerCode code={serverCode} onRetry={onRetryServerCode} />
      </section>
    )}
    {review.workflows.length === 0 ? null : (
      <section aria-label="Workflows" className="flex flex-col gap-1">
        <h4 className="font-medium">Workflows</h4>
        <ul className="flex flex-col gap-2">
          {review.workflows.map((workflow) => (
            <li className="flex flex-col gap-1" key={workflow.id}>
              <span className="flex items-center gap-2">
                {changeWords[workflow.change]} workflow{" "}
                <code className="font-mono">{workflow.id}</code>
                {workflow.sideEffect && workflow.change !== "removed" ? (
                  <Badge variant="destructive">
                    May change something outside Grasp
                  </Badge>
                ) : null}
              </span>
              {workflow.change === "removed" ? (
                <span className="text-muted-foreground">
                  It no longer runs
                  {workflow.sideEffect ? " (it could change things)" : ""}.
                </span>
              ) : null}
              {workflow.triggers === null ? (
                <span className="text-muted-foreground">
                  What makes it run on its own can&apos;t be read from its code.
                </span>
              ) : (
                workflow.triggers.map((change) => (
                  <span
                    key={`${change.change}:${JSON.stringify(change.trigger)}`}
                  >
                    {triggerChangeText(change)}
                  </span>
                ))
              )}
              {workflow.shared.length === 0 ? null : (
                <span className="text-muted-foreground">
                  Code it may use changed: {workflow.shared.join(", ")}
                </span>
              )}
              {workflow.steps === null ? (
                <span className="text-muted-foreground">
                  Its steps can&apos;t be read from its code, so it may do
                  anything its code does.
                </span>
              ) : (
                workflow.steps.map((step) => (
                  <span className="flex items-center gap-2" key={step.name}>
                    {changeWords[step.change]} step {step.name}
                    {step.sideEffect ? (
                      <Badge variant="destructive">
                        May change something outside Grasp
                      </Badge>
                    ) : null}
                    {step.calls.length === 0 ? null : (
                      <Badge variant="outline">
                        Calls {step.calls.join(", ")}: may change things
                      </Badge>
                    )}
                    {step.sharedCode ? (
                      <Badge variant="outline">Shared code changed</Badge>
                    ) : null}
                  </span>
                ))
              )}
              {workflow.params === null ? (
                <span className="text-muted-foreground">
                  Its parameters can&apos;t be read from its code.
                </span>
              ) : (
                workflow.params.map((param) => (
                  <span key={param.name}>
                    {changeWords[param.change]} parameter {param.name}
                  </span>
                ))
              )}
            </li>
          ))}
        </ul>
      </section>
    )}
    {review.exports.length === 0 ? null : (
      <section aria-label="Exports" className="flex flex-col gap-1">
        <h4 className="font-medium">What other Apps may call</h4>
        <ul className="flex flex-col gap-1">
          {review.exports.map((change) => {
            const { text, widens } = exportChangeText(change);
            return (
              <li className="flex items-center gap-2" key={change.name}>
                {text}
                {widens ? (
                  <Badge variant="destructive">
                    Changes the App&apos;s data
                  </Badge>
                ) : null}
              </li>
            );
          })}
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
  onDone: (made: string) => void;
}) => {
  const [review, setReview] = useState<
    Loaded<VersionReview> | { state: "hidden" }
  >();
  const [serverCode, setServerCode] = useState<Loaded<ServerFile[]>>();
  // Bumped to read what failed again.
  const [reviewReads, setReviewReads] = useState(0);
  const [codeReads, setCodeReads] = useState(0);
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await readReview(core, app.id, version);
      if (current) {
        setReview(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `reviewReads` says when to read again
  }, [core, app.id, version, reviewReads]);
  const loaded = review?.state === "ready" ? review.data : undefined;
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      if (loaded === undefined || loaded.server === null) {
        return;
      }
      const found = await loadFromCore(
        core,
        async (session) =>
          await serverCodeOf(session, {
            app: app.id,
            current: loaded.current,
            version,
            serverFiles: loaded.serverFiles,
          })
      );
      if (current) {
        setServerCode(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `codeReads` says when to read again
  }, [core, app.id, version, loaded, codeReads]);
  const makeCurrent = async (): Promise<void> => {
    const made = await run(
      async (session) => await session.apps.versions.setCurrent(app.id, version)
    );
    if (made !== undefined) {
      onDone(versionKey(app.id, version));
    }
  };
  if (review === undefined) {
    return null;
  }
  if (review.state === "hidden") {
    return null;
  }
  // Only once all of what the reviewer reads has loaded.
  const ready = readyToMakeCurrent(
    review,
    loaded !== undefined && loaded.server !== null,
    serverCode
  );
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          {app.name}: version {version} waiting for review
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loaded === undefined ? (
          <div className="flex items-center gap-2">
            <NotLoaded page={review} />
            <Button
              onClick={() => {
                setReviewReads(reviewReads + 1);
              }}
              size="sm"
              variant="outline"
            >
              Load the review again
            </Button>
          </div>
        ) : (
          <ReviewDetails
            onRetryServerCode={() => {
              setCodeReads(codeReads + 1);
            }}
            review={loaded}
            serverCode={serverCode}
          />
        )}
        <ErrorText>{failure}</ErrorText>
      </CardContent>
      {loaded === undefined ? null : (
        <CardFooter>
          <Button
            disabled={busy || !ready}
            onClick={() => {
              void makeCurrent();
            }}
          >
            Make version {version} current
          </Button>
        </CardFooter>
      )}
    </Card>
  );
};

/**
 * The preview of a draft: its first screen, or one it changes the person
 * picks. Loaded afresh at each of the draft's writes, as its key says.
 */
const DraftPreview = ({
  chatId,
  draft,
  name,
}: {
  chatId: string;
  draft: ChatDraft;
  name: string;
}) => {
  const [picked, setPicked] = useState<string>();
  const screens = changedScreens(draft);
  const screen = previewedScreen(screens, picked);
  return (
    <section
      aria-label={`Preview of ${name}`}
      className="flex h-96 flex-col gap-2"
    >
      {screens.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          {screens.map((one) => (
            <Button
              key={one}
              onClick={() => {
                setPicked(one);
              }}
              size="sm"
              variant={one === screen ? "secondary" : "ghost"}
            >
              {one}
            </Button>
          ))}
        </div>
      ) : null}
      <PreviewFrame
        app={draft.app}
        chatId={chatId}
        key={`${draft.app}:${draft.revision}:${screen ?? ""}`}
        {...(screen === undefined ? {} : { screen })}
      />
    </section>
  );
};

/**
 * The Apps being built: the chat's drafts, and versions up for review.
 * Read again whenever the agent stops working (`running` turns false) or
 * writes or drops a draft (`drafts` changes), and after a version is made
 * current here, whatever the agent does. The draft written last, or the
 * one the person picks, shows its preview.
 */
export const ChatBuilds = ({
  chatId,
  running,
  drafts,
}: {
  chatId: string;
  running: boolean;
  drafts: number;
}) => {
  // The draft whose preview shows, by App; the latest when none is picked.
  const [previewing, setPreviewing] = useState<string>();
  const [builds, setBuilds] = useState<Loaded<Builds>>();
  const [reads, setReads] = useState(0);
  // Versions made current here: gone from the section at once.
  const [madeCurrent, setMadeCurrent] = useState<ReadonlySet<string>>(
    new Set()
  );
  // Only the latest read shows, whichever ends last.
  const latest = useRef(0);
  // The reads asked for (after making a version current) done so far:
  // those go whether the agent works or not.
  const handledReads = useRef(0);
  // The drafts' changes read so far: those go whether the agent works or
  // not, so a preview follows each write.
  const handledDrafts = useRef(-1);
  const core = useCore();
  useEffect(() => {
    if (
      running &&
      reads === handledReads.current &&
      drafts === handledDrafts.current
    ) {
      return;
    }
    handledReads.current = reads;
    handledDrafts.current = drafts;
    latest.current += 1;
    const read = latest.current;
    const load = async (): Promise<void> => {
      const found = await readBuilds(core, chatId);
      if (latest.current === read) {
        setBuilds(found);
        if (found.state === "ready") {
          setMadeCurrent((made) => stillMadeCurrent(made, found.data.apps));
        }
      }
    };
    void load();
  }, [core, chatId, running, reads, drafts]);
  if (builds === undefined) {
    return null;
  }
  if (builds.state !== "ready") {
    return <NotLoaded page={builds} />;
  }
  const names = new Map<string, string>(
    builds.data.apps.map((app) => [app.id, app.name])
  );
  const pending = pendingToShow(builds.data.apps, madeCurrent);
  if (builds.data.drafts.length === 0 && pending.length === 0) {
    return null;
  }
  const previewed =
    builds.data.drafts.find(({ app }) => app === previewing) ??
    builds.data.drafts[0];
  return (
    <section aria-label="Being built" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Being built</h3>
      {builds.data.drafts.map((draft) => (
        <div
          className="flex items-center justify-between gap-2"
          key={draft.app}
        >
          <p className="text-sm">
            {names.get(draft.app) ?? draft.app}: {draft.changed.length}{" "}
            {draft.changed.length === 1 ? "file" : "files"} changed in this
            chat, not proposed yet
          </p>
          {draft === previewed ? null : (
            <Button
              onClick={() => {
                setPreviewing(draft.app);
              }}
              size="sm"
              variant="outline"
            >
              Preview
            </Button>
          )}
        </div>
      ))}
      {previewed === undefined ? null : (
        <DraftPreview
          chatId={chatId}
          draft={previewed}
          key={previewed.app}
          name={names.get(previewed.app) ?? previewed.app}
        />
      )}
      {pending.map((app) => (
        <PendingVersion
          app={app}
          key={versionKey(app.id, app.pendingVersion)}
          onDone={(made) => {
            setMadeCurrent((before) => new Set([...before, made]));
            setReads(reads + 1);
          }}
          version={app.pendingVersion}
        />
      ))}
    </section>
  );
};
