import type { App, AppContents } from "@grasp-os/shared/apps";
import { Button } from "@grasp-os/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ScreenFrame } from "../screens/screen-frame.tsx";
import { ChatBuilds } from "./builds.tsx";

// Beside the chat: a slot for what the chat is about. The Apps its agent
// is building (builds.tsx), and one of the person's Apps, its screen
// running beside the conversation, and a way to its workflows on the
// App's page.

/** The App open in the panel, and what it has to show. */
interface Opened {
  app: App;
  contents: AppContents;
}

const OpenedApp = ({
  opened: { app, contents },
  onClose,
}: {
  opened: Opened;
  onClose: () => void;
}) => {
  const [screen] = contents.screens;
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button onClick={onClose} size="sm" variant="ghost">
          All Apps
        </Button>
        <Link
          className="text-sm underline"
          params={{ app: app.id }}
          to="/apps/$app"
        >
          Workflows and more
        </Link>
      </div>
      {screen === undefined || contents.version === null ? (
        <p className="text-muted-foreground text-sm">
          {app.name} has no screen to show.
        </p>
      ) : (
        <ScreenFrame app={app.id} embedded screen={screen} />
      )}
    </div>
  );
};

/**
 * The side panel: what the chat's agent is building, and the person's
 * Apps, one of them open.
 */
export const SidePanel = ({
  chatId,
  running,
  drafts,
}: {
  chatId: string;
  running: boolean;
  drafts: number;
}) => {
  const [apps, setApps] = useState<Loaded<App[]>>();
  const [opened, setOpened] = useState<Loaded<Opened>>();
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        async (session) => await session.apps.list()
      );
      if (current) {
        setApps(found);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, []);
  // Only the App opened last shows, whichever read ends last.
  const latest = useRef<App | null>(null);
  const open = async (app: App): Promise<void> => {
    latest.current = app;
    const found = await loadFromCore(async (session) => ({
      app,
      contents: await session.apps.contents(app.id),
    }));
    if (latest.current === app) {
      setOpened(found);
    }
  };
  if (opened?.state === "ready") {
    return (
      <OpenedApp
        onClose={() => {
          latest.current = null;
          setOpened(undefined);
        }}
        opened={opened.data}
      />
    );
  }
  if (apps === undefined) {
    return null;
  }
  if (apps.state !== "ready") {
    return <NotLoaded page={apps} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <ChatBuilds chatId={chatId} drafts={drafts} running={running} />
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Apps</h2>
        {opened === undefined ? null : <NotLoaded page={opened} />}
        {apps.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">No Apps yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {apps.data.map((app) => (
              <li key={app.id}>
                <Button
                  className="w-full justify-start"
                  onClick={() => {
                    void open(app);
                  }}
                  variant="ghost"
                >
                  {app.name}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
