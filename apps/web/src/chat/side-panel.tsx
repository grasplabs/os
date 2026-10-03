import type { App, AppContents } from "@grasp-os/shared/apps";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BoxIcon,
  BoxesIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ScreenFrame } from "../screens/screen-frame.tsx";
import { useCore } from "../use-core.ts";
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
  const { name } = app;
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button onClick={onClose} size="sm" variant="ghost">
          <ArrowLeftIcon data-icon="inline-start" />
          <Trans>All Apps</Trans>
        </Button>
        <Link
          className="text-sm underline"
          params={{ app: app.id }}
          to="/apps/$app"
        >
          <Trans>Workflows and more</Trans>
        </Link>
      </div>
      {screen === undefined || contents.version === null ? (
        <p className="text-muted-foreground text-sm">
          <Trans>{name} has no screen to show.</Trans>
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
  const { t } = useLingui();
  const [apps, setApps] = useState<Loaded<App[]>>();
  const core = useCore();
  const [opened, setOpened] = useState<Loaded<Opened>>();
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const found = await loadFromCore(
        core,
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
  }, [core]);
  // Only the App opened last shows, whichever read ends last.
  const latest = useRef<App | null>(null);
  const open = async (app: App): Promise<void> => {
    latest.current = app;
    const found = await loadFromCore(core, async (session) => ({
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
    return <Spinner aria-label={t`Loading…`} className="self-center" />;
  }
  if (apps.state !== "ready") {
    return <NotLoaded page={apps} />;
  }
  return (
    <div className="flex flex-col gap-6">
      <ChatBuilds chatId={chatId} drafts={drafts} running={running} />
      <section aria-labelledby="panel-apps" className="flex flex-col gap-2">
        <h2
          className="flex items-center gap-2 text-sm font-medium"
          id="panel-apps"
        >
          <BoxesIcon
            aria-hidden="true"
            className="text-muted-foreground size-4"
          />
          <Trans>Apps</Trans>
        </h2>
        {opened === undefined ? null : <NotLoaded page={opened} />}
        {apps.data.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <BoxesIcon />
              </EmptyMedia>
              <EmptyTitle>
                <Trans>No Apps yet</Trans>
              </EmptyTitle>
              <EmptyDescription>
                <Trans>
                  Ask Grasp to build one. While it works, the App shows here to
                  preview before it is proposed.
                </Trans>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="-mx-2 flex flex-col gap-0.5">
            {apps.data.map((app) => (
              <li key={app.id}>
                <button
                  className="hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm outline-none focus-visible:ring-2"
                  onClick={() => {
                    void open(app);
                  }}
                  type="button"
                >
                  <BoxIcon
                    aria-hidden="true"
                    className="text-muted-foreground size-4 flex-none"
                  />
                  <span className="min-w-0 flex-1 truncate">{app.name}</span>
                  <ChevronRightIcon
                    aria-hidden="true"
                    className="text-muted-foreground size-4 flex-none"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
