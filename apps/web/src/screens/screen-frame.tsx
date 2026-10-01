import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import { runPreview, runScreen } from "./screen-host.ts";
import type { FailureReason, ScreenState } from "./screen-host.ts";

const failureMessages: Readonly<Record<FailureReason, MessageDescriptor>> = {
  forbidden: msg`You can't open this App's screens: your role doesn't allow it, or the App has read data you can't read.`,
  "not-found": msg`This App has no such screen.`,
  "not-running": msg`This App has no version to run yet.`,
  broken: msg`This screen doesn't build. Ask a builder to fix it.`,
  unknown: msg`The screen couldn't be loaded.`,
};

interface StatusProps {
  state: ScreenState;
  onReload: () => void;
}

/** What the page says about the screen, and how to load it again. */
const ScreenStatus = ({ state, onReload }: StatusProps) => {
  const { t, i18n } = useLingui();
  if (state.status === "loading" || state.status === "running") {
    return null;
  }
  let message = i18n._(failureMessages.unknown);
  if (state.status === "updated") {
    message = t`A new version of this App is available.`;
  } else if (state.status === "signed-out") {
    message = t`Your session has ended. Sign in again to go on.`;
  } else if (state.status === "failed") {
    message = i18n._(failureMessages[state.reason]);
  }
  return (
    <div className="flex items-center justify-between gap-4 border-b p-3 print:hidden">
      <output className="text-sm">{message}</output>
      {state.status === "signed-out" ? null : (
        <Button onClick={onReload} size="sm" variant="outline">
          {state.status === "updated" ? t`Reload` : t`Try again`}
        </Button>
      )}
    </div>
  );
};

/**
 * What a frame runs: screen `screen` of App `app`, or, with `chatId`, a
 * preview of that chat's draft of `app` (its first changed screen when
 * `screen` is left out). Plain values, so the frame starts again only
 * when one of them changes, never because the page drew itself again.
 */
interface FrameSource {
  app: string;
  screen?: string;
  chatId?: string;
}

/** Starts what `source` names in `frame`; returns what stops it. */
const start = (
  frame: HTMLIFrameElement,
  { app, screen, chatId }: FrameSource,
  onState: (state: ScreenState) => void,
  onOpened: (appName: string) => void
): (() => void) =>
  chatId === undefined
    ? runScreen(frame, app, screen ?? "", onState, onOpened)
    : runPreview(
        frame,
        { chatId, app, ...(screen === undefined ? {} : { screen }) },
        onState,
        onOpened
      );

interface FrameProps extends FrameSource {
  title: string;
  onState: (state: ScreenState) => void;
  onOpened: (appName: string) => void;
}

/**
 * The sandboxed frame itself. Its document is set once the page listens
 * for it (screen-host.ts); a new element is a fresh start.
 */
const Frame = ({
  app,
  screen,
  chatId,
  title,
  onState,
  onOpened,
}: FrameProps) => {
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  useEffect(
    () =>
      frame
        ? start(
            frame,
            {
              app,
              ...(screen === undefined ? {} : { screen }),
              ...(chatId === undefined ? {} : { chatId }),
            },
            onState,
            onOpened
          )
        : undefined,
    [frame, app, screen, chatId, onState, onOpened]
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
 * What `source` names, running in a sandboxed frame, inside the page's
 * own chrome: `label` and the App's name, which say an App drew what's
 * below. A screen can draw anything in its frame, a fake sign-in prompt
 * too; the chrome is how a person tells the App's part from Grasp's. It
 * doesn't print: printed, the page is the screen alone, filling the
 * paper, and the screen's own print styles decide what's on it.
 */
const FramedScreen = ({
  source,
  title,
  label,
  embedded,
  onReload,
}: {
  source: FrameSource;
  title: string;
  label: string;
  embedded: boolean;
  onReload?: () => void;
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
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center gap-2 border-b p-3 print:hidden">
        <Badge variant="secondary">{label}</Badge>
        <Title className="text-sm font-medium">{appName}</Title>
      </header>
      <ScreenStatus onReload={reload} state={state} />
      <Frame
        app={source.app}
        key={attempt}
        onOpened={setAppName}
        onState={setState}
        title={title}
        {...(source.screen === undefined ? {} : { screen: source.screen })}
        {...(source.chatId === undefined ? {} : { chatId: source.chatId })}
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
  const { t } = useLingui();
  return (
    <FramedScreen
      embedded={embedded}
      label={t`App screen`}
      source={{ app, screen }}
      title={t`${screen} screen`}
      {...(onReload === undefined ? {} : { onReload })}
    />
  );
};

/**
 * A screen of the chat's draft of `app` (its first changed one when none
 * is named), running in a sandboxed frame as a preview: its server code
 * changes nothing and reads no real data, and what goes wrong goes to the
 * agent.
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
  const { t } = useLingui();
  return (
    <FramedScreen
      embedded
      label={t`Preview: changes nothing, reads no real data`}
      source={{ chatId, app, ...(screen === undefined ? {} : { screen }) }}
      title={
        screen === undefined
          ? t`Preview of the draft's first screen`
          : t`Preview of ${screen} screen`
      }
    />
  );
};
