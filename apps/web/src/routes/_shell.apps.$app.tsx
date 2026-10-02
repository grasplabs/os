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
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Await,
  createFileRoute,
  Link,
  useRouter,
} from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { SiteHeader } from "../frame/site-header.tsx";
import { roleLabel } from "../labels.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { ScreenFrame } from "../screens/screen-frame.tsx";
import { runStatusLabel } from "../workflows/runs.tsx";

// One App: its screens, running in their frames, its workflows with their
// latest runs, and who can open it.

/**
 * The App's runs, read on a connection of their own: a read that hangs or
 * is refused only leaves the Workflows tab empty.
 */
type Runs = Promise<Loaded<WorkflowRun[]>>;

/**
 * Whom the App is shared with, read the same way: a refused read leaves
 * only the Members tab without them.
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
        <Trans>This App has no version to run yet.</Trans>
      </p>
    );
  }
  if (selected === undefined) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>This App&apos;s current version has no screens.</Trans>
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
          <Trans>Open full page</Trans>
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
    <p className="text-muted-foreground text-sm">
      <Trans>No runs yet.</Trans>
    </p>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Trans>Workflow</Trans>
          </TableHead>
          <TableHead>
            <Trans>Status</Trans>
          </TableHead>
          <TableHead>
            <Trans>Version</Trans>
          </TableHead>
          <TableHead>
            <Trans>Started</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id}>
            <TableCell>{run.workflow}</TableCell>
            <TableCell>{runStatusLabel(run.status)}</TableCell>
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
}) => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-6">
      {contents.workflows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>This App&apos;s current version has no workflows.</Trans>
        </p>
      ) : (
        <ul aria-label={t`Workflows`} className="flex flex-col gap-1">
          {contents.workflows.map((workflow) => (
            <li key={workflow}>{workflow}</li>
          ))}
        </ul>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">
          <Trans>Runs</Trans>
        </h2>
        <Await
          fallback={
            <p className="text-muted-foreground text-sm">
              <Trans>Loading runs…</Trans>
            </p>
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
};

const MembersTable = ({ members }: { members: AppMember[] }) =>
  members.length === 0 ? (
    <p className="text-muted-foreground">
      <Trans>It isn&apos;t shared with anyone.</Trans>
    </p>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Trans>Shared with</Trans>
          </TableHead>
          <TableHead>
            <Trans>Role</Trans>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <TableRow key={`${member.type}:${member.id}`}>
            <TableCell>
              {member.type === "team"
                ? i18n._(msg`${member.name ?? member.id} (team)`)
                : (member.name ?? member.id)}
            </TableCell>
            <TableCell>{roleLabel(member.role)}</TableCell>
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
  const { t } = useLingui();
  const { owner } = app;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p>
        {owner === identity.userId
          ? t`Created by you.`
          : t`Created by the member ${owner}.`}
      </p>
      <Await
        fallback={
          <p className="text-muted-foreground">
            <Trans>Loading members…</Trans>
          </p>
        }
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
  const { t } = useLingui();
  const { version } = contents;
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">{app.name}</h1>
        {app.description === "" ? null : (
          <p className="text-muted-foreground text-sm">{app.description}</p>
        )}
        <p className="text-muted-foreground text-sm">
          {version === null ? t`Not released` : t`Version ${version}`}
        </p>
      </div>
      <Tabs className="min-h-0 flex-1" defaultValue="screens">
        <TabsList>
          <TabsTrigger value="screens">
            <Trans>Screens</Trans>
          </TabsTrigger>
          <TabsTrigger value="workflows">
            <Trans>Workflows</Trans>
          </TabsTrigger>
          <TabsTrigger value="members">
            <Trans>Members</Trans>
          </TabsTrigger>
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
  const { t } = useLingui();
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Apps`, to: "/apps" },
          { label: page.state === "ready" ? page.data.app.name : t`App` },
        ]}
      />
      <div className="flex flex-1 flex-col gap-4 p-6">
        {page.state === "ready" ? (
          <AppView
            key={page.data.app.id}
            members={members}
            page={page.data}
            runs={runs}
          />
        ) : (
          <>
            <h1 className="text-2xl font-medium">
              <Trans>App</Trans>
            </h1>
            <NotLoaded page={page} />
          </>
        )}
      </div>
    </>
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
