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

import { timeoutMs, withTimeout } from "../core.ts";
import type { Session } from "../core.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// The Apps the person can open, as core lists them, with what each one's
// current version offers.

interface ListedApp {
  app: App;
  /** Undefined when core didn't answer for this App. */
  contents?: AppContents;
}

/**
 * The Apps core lets the person open: their own, those shared with them,
 * and every App for admins. A list refused to their role is none.
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

/**
 * How long one App's contents may take: half the page's own limit, so an
 * App whose read hangs costs only its row, never the whole list.
 */
const contentsTimeoutMs = timeoutMs / 2;

const listApps = async (session: Session): Promise<ListedApp[]> => {
  const apps = await openableApps(session);
  // One App whose contents can't be read (a damaged version, a read that
  // hangs) still leaves the others, and its own row.
  const contents = await Promise.allSettled(
    apps.map(
      async (app) =>
        await withTimeout(session.apps.contents(app.id), contentsTimeoutMs)
    )
  );
  return apps.map((app, index) => {
    const read = contents[index];
    return read?.status === "fulfilled"
      ? { app, contents: read.value }
      : { app };
  });
};

/** A cell of an App's contents, or a note that core didn't answer. */
const contentsCell = (
  contents: AppContents | undefined,
  show: (read: AppContents) => string
): string => (contents === undefined ? "Contents unavailable" : show(contents));

const versionOf = ({ version }: AppContents): string =>
  version === null ? "Not released" : String(version);

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
            <TableCell>{contentsCell(contents, versionOf)}</TableCell>
            <TableCell>
              {contentsCell(contents, ({ screens }) => listed(screens))}
            </TableCell>
            <TableCell>
              {contentsCell(contents, ({ workflows }) => listed(workflows))}
            </TableCell>
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
  loader: async ({ context: { core } }) => await loadFromCore(core, listApps),
});
