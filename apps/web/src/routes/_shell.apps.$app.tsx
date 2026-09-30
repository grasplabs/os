import type { App, AppContents, AppMember } from "@grasp-os/shared/apps";
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
import {
  Await,
  createFileRoute,
  Link,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ScreenFrame } from "../screens/screen-frame.tsx";

// One App: its screens, running in their frames, its workflows with their
// latest runs, and who can open it.

/**
 * The App's runs, read on a connection of their own: a read that hangs or
 * is refused (workflows switched off) only leaves the Workflows tab empty.
 */
type Runs = Promise<Loaded<WorkflowRun[]>>;

/**
 * Whom the App is shared with, read the same way: refused while sharing
 * Apps is switched off, which leaves only the Members tab without them.
 */
type MemberList = Promise<Loaded<AppMember[]>>;

interface AppPage {
  app: App;
  contents: AppContents;
}

const loadApp = async (session: Session, app: string): Promise<AppPage> => {
  const [found, contents] = await Promise.all([
    session.apps.get(app),
    session.apps.contents(app),
  ]);
  return { app: found, contents };
};

const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const Screens = ({ app, contents }: { app: string; contents: AppContents }) => {
  const router = useRouter();
  const [first] = contents.screens;
  const [chosen, setChosen] = useState(first);
  // A new version can remove the screen chosen: then the first one shows.
  const selected =
    chosen !== undefined && contents.screens.includes(chosen) ? chosen : first;
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
              setChosen(screen);
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
        <ScreenFrame
          app={app}
          embedded
          key={selected}
          // Loading the screen again reads the App's current version again
          // too: its screens may have changed with it.
          onReload={() => {
            void router.invalidate();
          }}
          screen={selected}
        />
      </div>
    </div>
  );
};

const RunsTable = ({ runs }: { runs: WorkflowRun[] }) =>
  runs.length === 0 ? (
    <p className="text-muted-foreground text-sm">No runs yet.</p>
  ) : (
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
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>{run.workflow}</TableCell>
            <TableCell>{run.status}</TableCell>
            <TableCell>{run.version}</TableCell>
            <TableCell>{dateTime.format(new Date(run.createdAt))}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

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
      <Await
        fallback={
          <p className="text-muted-foreground text-sm">Loading runs…</p>
        }
        promise={runs}
      >
        {(loaded) =>
          loaded.state === "ready" ? (
            <RunsTable runs={loaded.data} />
          ) : (
            <NotLoaded page={loaded} />
          )
        }
      </Await>
    </section>
  </div>
);

const MembersTable = ({ members }: { members: AppMember[] }) =>
  members.length === 0 ? (
    <p className="text-muted-foreground">It isn&apos;t shared with anyone.</p>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Shared with</TableHead>
          <TableHead>Role</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={`${member.type}:${member.id}`}>
            <TableCell>
              {member.name ?? member.id}
              {member.type === "team" ? " (team)" : ""}
            </TableCell>
            <TableCell>{member.role}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

/**
 * Who opens the App: its owner and the admins, who build it, and the
 * people and teams it is shared with, each as a user or a builder.
 */
const Members = ({ app, members }: { app: App; members: MemberList }) => {
  const { identity } = Route.useRouteContext();
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        Created by{" "}
        {app.owner === identity.userId ? "you" : `the member ${app.owner}`}.
      </p>
      <Await
        fallback={<p className="text-muted-foreground">Loading members…</p>}
        promise={members}
      >
        {(loaded) =>
          loaded.state === "ready" ? (
            <MembersTable members={loaded.data} />
          ) : (
            <NotLoaded page={loaded} />
          )
        }
      </Await>
    </div>
  );
};

const AppView = ({
  page,
  runs,
  members,
}: {
  page: AppPage;
  runs: Runs;
  members: MemberList;
}) => {
  const { app, contents } = page;
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
          <Members app={app} members={members} />
        </TabsContent>
      </Tabs>
    </>
  );
};

const AppPageView = () => {
  const { page, runs, members } = Route.useLoaderData();
  return (
    <main className="flex flex-1 flex-col gap-4 p-6">
      {page.state === "ready" ? (
        <AppView
          key={page.data.app.id}
          members={members}
          page={page.data}
          runs={runs}
        />
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
  loader: async ({ context: { core }, params }) => ({
    // Not awaited: only their tabs wait for them.
    runs: loadFromCore(
      core,
      async (session) => await session.workflows.list(params.app)
    ),
    members: loadFromCore(
      core,
      async (session) => await session.apps.members.list(params.app)
    ),
    page: await loadFromCore(
      core,
      async (session) => await loadApp(session, params.app)
    ),
  }),
});
