import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useState } from "react";

import { runPreview, runScreen } from "./screen-host.ts";
import type { FailureReason, ScreenState } from "./screen-host.ts";

const failureMessages: Readonly<Record<FailureReason, string>> = {
  disabled: "Screens aren't switched on for this organization.",
  forbidden:
    "You can't open this App's screens: your role doesn't allow it, or the App has read data you can't read.",
  "not-found": "This App has no such screen.",
  "not-running": "This App has no version to run yet.",
  broken: "This screen doesn't build. Ask a builder to fix it.",
  unknown: "The screen couldn't be loaded.",
};

interface StatusProps {
  state: ScreenState;
  onReload: () => void;
}

/** What the page says about the screen, and how to load it again. */
const ScreenStatus = ({ state, onReload }: StatusProps) => {
  if (state.status === "loading" || state.status === "running") {
    return null;
  }
  let message = failureMessages.unknown;
  if (state.status === "updated") {
    message = "A new version of this App is available.";
  } else if (state.status === "signed-out") {
    message = "Your session has ended. Sign in again to go on.";
  } else if (state.status === "failed") {
    message = failureMessages[state.reason];
  }
  return (
    <div className="flex items-center justify-between gap-4 border-b p-3 print:hidden">
      <output className="text-sm">{message}</output>
      {state.status === "signed-out" ? null : (
        <Button onClick={onReload} size="sm" variant="outline">
          {state.status === "updated" ? "Reload" : "Try again"}
        </Button>
      )}
    </div>
  );
};

/** Starts what a frame runs; returns what stops it (screen-host.ts). */
type Start = (
  frame: HTMLIFrameElement,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
) => () => void;

interface FrameProps {
  start: Start;
  title: string;
  onState: (state: ScreenState) => void;
  onOpened: (appName: string) => void;
}

/**
 * The sandboxed frame itself. Its document is set once the page listens
 * for it (screen-host.ts); a new element is a fresh start.
 */
const Frame = ({ start, title, onState, onOpened }: FrameProps) => {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  useEffect(
    () => (frame ? start(frame, onState, onOpened) : undefined),
    [frame, start, onState, onOpened]
  );
  return (
    <iframe
      className="w-full flex-1 border-0"
      ref={setFrame}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      title={title}
    />
  );
};

/**
 * What `start` runs in a sandboxed frame, inside the page's own chrome:
 * `label` and the App's name, which say an App drew what's below. A
 * screen can draw anything in its frame, a fake sign-in prompt too; the
 * chrome is how a person tells the App's part from Grasp's. It doesn't
 * print: printed, the page is the screen alone, filling the paper, and
 * the screen's own print styles decide what's on it.
 */
const FramedScreen = ({
  start,
  title,
  label,
  embedded,
  onReload,
  hiddenWhenOff = false,
}: {
  start: Start;
  title: string;
  label: string;
  embedded: boolean;
  onReload?: () => void;
  /** Shows nothing while what it runs is switched off. */
  hiddenWhenOff?: boolean;
}) => {
  const Title = embedded ? "h2" : "h1";
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  const [appName, setAppName] = useState("");
  const [attempt, setAttempt] = useState(0);
  const reload = () => {
    setState({ status: "loading" });
    setAttempt(attempt + 1);
    onReload?.();
  };
  if (
    hiddenWhenOff &&
    state.status === "failed" &&
    state.reason === "disabled"
  ) {
    return null;
  }
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center gap-2 border-b p-3 print:hidden">
        <Badge variant="secondary">{label}</Badge>
        <Title className="text-sm font-medium">{appName}</Title>
      </header>
      <ScreenStatus onReload={reload} state={state} />
      <Frame
        key={attempt}
        onOpened={setAppName}
        onState={setState}
        start={start}
        title={title}
      />
    </div>
  );
};

interface ScreenFrameProps {
  app: string;
  screen: string;
  /**
   * Inside a page with a heading of its own (the App's page): the App's
   * name is a second-level heading, not the page's.
   */
  embedded?: boolean;
  /** Also called when the person loads the screen again. */
  onReload?: () => void;
}

/** An App's screen, running in a sandboxed frame (`FramedScreen`). */
export const ScreenFrame = ({
  app,
  screen,
  embedded = false,
  onReload,
}: ScreenFrameProps) => {
  const start: Start = (frame, onState, onOpened) =>
    runScreen(frame, app, screen, onState, onOpened);
  return (
    <FramedScreen
      embedded={embedded}
      label="App screen"
      start={start}
      title={`${screen} screen`}
      {...(onReload === undefined ? {} : { onReload })}
    />
  );
};

/**
 * A screen of the chat's draft of `app` (its first when none is named),
 * running in a sandboxed frame as a preview: its server code changes
 * nothing and reads no real data, and what goes wrong goes to the agent.
 */
export const PreviewFrame = ({
  chatId,
  app,
  screen,
}: {
  chatId: string;
  app: string;
  screen?: string;
}) => {
  const start: Start = (frame, onState, onOpened) =>
    runPreview(
      frame,
      { chatId, app, ...(screen === undefined ? {} : { screen }) },
      onState,
      onOpened
    );
  return (
    <FramedScreen
      embedded
      hiddenWhenOff
      label="Preview: changes nothing, reads no real data"
      start={start}
      title={`Preview of ${screen ?? "the draft's first"} screen`}
    />
  );
};
