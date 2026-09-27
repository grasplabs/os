import type { App, AppContents } from "@grasp-os/shared/apps";
import { messageOf } from "@grasp-os/shared/errors";
import type { WorkflowRun } from "@grasp-os/shared/workflows";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import { ScreenFrame } from "../screens/screen-frame.tsx";

// One App: its screens, running in their frames, its workflows with their
// latest runs, and who can open it.

/** The App's runs, or why core didn't list them (workflows switched off). */
type Runs = { runs: WorkflowRun[] } | { failure: string };

const runsOf = async (session: Session, app: string): Promise<Runs> => {
  try {
    return { runs: await session.workflows.list(app) };
  } catch (error) {
    return { failure: messageOf(error) };
  }
};

interface AppPage {
  app: App;
  contents: AppContents;
  runs: Runs;
}

const loadApp = async (session: Session, app: string): Promise<AppPage> => {
  const [found, contents, runs] = await Promise.all([
    session.apps.get(app),
    session.apps.contents(app),
    runsOf(session, app),
  ]);
  return { app: found, contents, runs };
};

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const Screens = ({ app, contents }: { app: string; contents: AppContents }) => {
  const [first] = contents.screens;
  const [selected, setSelected] = useState(first);
  if (contents.version === null) {
    return (
      <p className="text-muted-foreground text-sm">
        This App has no version to run yet.
      </p>
    );
  }
  if (selected === undefined) {
    return (
      <p className="text-muted-foreground text-sm">
        This App&apos;s current version has no screens.
      </p>
    );
  }
  return (
    <div className="flex flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {contents.screens.map((screen) => (
          <Button
            aria-pressed={screen === selected}
            key={screen}
            onClick={() => {
              setSelected(screen);
            }}
            size="sm"
            variant={screen === selected ? "secondary" : "ghost"}
          >
            {screen}
          </Button>
        ))}
        <Link
          className="ml-auto text-sm underline"
          params={{ app, screen: selected }}
          to="/apps/$app/screens/$screen"
        >
          Open full page
        </Link>
      </div>
      <div className="flex min-h-96 flex-1 flex-col rounded-lg border">
        <ScreenFrame app={app} key={selected} screen={selected} />
      </div>
    </div>
  );
};

const Workflows = ({
  contents,
  runs,
}: {
  contents: AppContents;
  runs: Runs;
}) => (
  <div className="flex flex-col gap-6">
    {contents.workflows.length === 0 ? (
      <p className="text-muted-foreground text-sm">
        This App&apos;s current version has no workflows.
      </p>
    ) : (
      <ul aria-label="Workflows" className="flex flex-col gap-1">
        {contents.workflows.map((workflow) => (
          <li key={workflow}>{workflow}</li>
        ))}
      </ul>
    )}
    <section className="flex flex-col gap-2">
      <h2 className="font-medium">Runs</h2>
      {"failure" in runs ? <ErrorText>{runs.failure}</ErrorText> : null}
      {"runs" in runs && runs.runs.length === 0 ? (
        <p className="text-muted-foreground text-sm">No runs yet.</p>
      ) : null}
      {"runs" in runs && runs.runs.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>{run.workflow}</TableCell>
                <TableCell>{run.status}</TableCell>
                <TableCell>{run.version}</TableCell>
                <TableCell>
                  {dateTime.format(new Date(run.createdAt))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </section>
  </div>
);

/**
 * Who opens the App. Apps have no members or roles of their own yet:
 * core opens every App to admins and builders, and none to anyone else.
 */
const Members = ({ app }: { app: App }) => {
  const { identity } = Route.useRouteContext();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        Apps don&apos;t have members of their own yet. Everyone with the admin
        or builder role opens every App; the user role opens none.
      </p>
      <p>
        Created by{" "}
        {app.owner === identity.userId ? "you" : `the member ${app.owner}`}.
      </p>
    </div>
  );
};

const AppView = ({ page }: { page: AppPage }) => {
  const { app, contents, runs } = page;
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">{app.name}</h1>
        {app.description === "" ? null : (
          <p className="text-muted-foreground text-sm">{app.description}</p>
        )}
        <p className="text-muted-foreground text-sm">
          {contents.version === null
            ? "Not released"
            : `Version ${contents.version}`}
        </p>
      </div>
      <Tabs className="min-h-0 flex-1" defaultValue="screens">
        <TabsList>
          <TabsTrigger value="screens">Screens</TabsTrigger>
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
        </TabsList>
        <TabsContent className="flex flex-col" value="screens">
          <Screens app={app.id} contents={contents} />
        </TabsContent>
        <TabsContent value="workflows">
          <Workflows contents={contents} runs={runs} />
        </TabsContent>
        <TabsContent value="members">
          <Members app={app} />
        </TabsContent>
      </Tabs>
    </>
  );
};

const AppPageView = () => {
  const page = Route.useLoaderData();
  return (
    <main className="flex flex-1 flex-col gap-4 p-6">
      {page.state === "ready" ? (
        <AppView key={page.data.app.id} page={page.data} />
      ) : (
        <>
          <h1 className="text-2xl font-medium">App</h1>
          <NotLoaded page={page} />
        </>
      )}
    </main>
  );
};

export const Route = createFileRoute("/_shell/apps/$app")({
  component: AppPageView,
  loader: async ({ params }) =>
    await loadFromCore(async (session) => await loadApp(session, params.app)),
});
