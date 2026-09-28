import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { useEffect, useState } from "react";

import { runScreen } from "./screen-host.ts";
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

interface ScreenFrameProps {
  app: string;
  screen: string;
}

interface ScreenFrameOptions extends ScreenFrameProps {
  /**
   * Inside a page with a heading of its own (the App's page): the App's
   * name is a second-level heading, not the page's.
   */
  embedded?: boolean;
  /** Also called when the person loads the screen again. */
  onReload?: () => void;
}

interface FrameProps extends ScreenFrameProps {
  onState: (state: ScreenState) => void;
  onOpened: (appName: string) => void;
}

/**
 * The sandboxed frame itself. Its document is set once the page listens
 * for it (screen-host.ts); a new element is a fresh start.
 */
const Frame = ({ app, screen, onState, onOpened }: FrameProps) => {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  useEffect(
    () =>
      frame ? runScreen(frame, app, screen, onState, onOpened) : undefined,
    [frame, app, screen, onState, onOpened]
  );
  return (
    <iframe
      className="w-full flex-1 border-0"
      ref={setFrame}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      title={`${screen} screen`}
    />
  );
};

/**
 * An App's screen, running in a sandboxed frame, inside the page's own
 * chrome: the App's name and a label that says an App drew what's below.
 * A screen can draw anything in its frame, a fake sign-in prompt too; the
 * chrome is how a person tells the App's part from Grasp's. It doesn't
 * print: printed, the page is the screen alone, filling the paper, and
 * the screen's own print styles decide what's on it.
 */
export const ScreenFrame = ({
  app,
  screen,
  embedded = false,
  onReload,
}: ScreenFrameOptions) => {
  const Title = embedded ? "h2" : "h1";
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  const [appName, setAppName] = useState("");
  const [attempt, setAttempt] = useState(0);
  const reload = () => {
    setState({ status: "loading" });
    setAttempt(attempt + 1);
    onReload?.();
  };
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center gap-2 border-b p-3 print:hidden">
        <Badge variant="secondary">App screen</Badge>
        <Title className="text-sm font-medium">{appName}</Title>
      </header>
      <ScreenStatus onReload={reload} state={state} />
      <Frame
        app={app}
        key={attempt}
        onOpened={setAppName}
        onState={setState}
        screen={screen}
      />
    </div>
  );
};
