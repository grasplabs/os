import type { App, AppContents } from "@grasp-os/shared/apps";
import { roleErrors } from "@grasp-os/shared/roles";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// The Apps the person can open, as core lists them, with what each one's
// current version offers.

interface ListedApp {
  app: App;
  contents: AppContents;
}

/**
 * The Apps core lets the person open. Apps have no members of their own
 * yet, so core opens them to the roles that build them and refuses anyone
 * else: someone core refuses for their role has no App to list.
 */
const openableApps = async (session: Session): Promise<App[]> => {
  try {
    return await session.apps.list();
  } catch (error) {
    if (roleErrors.codeOf(error) === "role.forbidden") {
      return [];
    }
    throw error;
  }
};

const listApps = async (session: Session): Promise<ListedApp[]> => {
  const apps = await openableApps(session);
  return await Promise.all(
    apps.map(async (app) => ({
      app,
      contents: await session.apps.contents(app.id),
    }))
  );
};

/** Names as a list for a table cell, or a dash for none. */
const listed = (names: string[]): string =>
  names.length === 0 ? "–" : names.join(", ");

const AppsTable = ({ apps }: { apps: ListedApp[] }) => {
  if (apps.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        There are no Apps you can open yet.
      </p>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Version</TableHead>
          <TableHead>Screens</TableHead>
          <TableHead>Workflows</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {apps.map(({ app, contents }) => (
          <TableRow key={app.id}>
            <TableCell>
              <Link
                className="underline"
                params={{ app: app.id }}
                to="/apps/$app"
              >
                {app.name}
              </Link>
            </TableCell>
            <TableCell>{app.description}</TableCell>
            <TableCell>
              {contents.version === null
                ? "Not released"
                : String(contents.version)}
            </TableCell>
            <TableCell>{listed(contents.screens)}</TableCell>
            <TableCell>{listed(contents.workflows)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const Apps = () => {
  const page = Route.useLoaderData();
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">Apps</h1>
      <NotLoaded page={page} />
      {page.state === "ready" ? <AppsTable apps={page.data} /> : null}
    </main>
  );
};

export const Route = createFileRoute("/_shell/apps/")({
  component: Apps,
  loader: async () => await loadFromCore(listApps),
});
