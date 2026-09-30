import { canBuild } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { connectionErrorMessage } from "../connection-errors.ts";
import { Catalog } from "../connections/catalog.tsx";
import { ConnectionList } from "../connections/connection-list.tsx";
import type { HeldPermissions } from "../connections/connection-list.tsx";
import type { Session } from "../core.ts";
import { listedOrNone } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// Connections: the person's own, the organization's shared ones, and the
// catalog to connect more from. A flow comes back here from the provider,
// through core's callback, with `connection=<id>` once it finished, or
// `connectionError=<code>` when it didn't.

/**
 * The Apps' names by ID; IDs stand in for them if the Apps can't be read
 * in time.
 */
const appNamesOf = async (
  session: Session
): Promise<ReadonlyMap<string, string>> => {
  const apps = await listedOrNone(session.apps.list());
  return new Map(apps.map(({ id, name }) => [id, name]));
};

/** Every active permission the person may list, with the Apps' names. */
const heldPermissions = async (session: Session): Promise<HeldPermissions> => {
  const [permissions, appNames] = await Promise.all([
    session.permissions.list(undefined, "active"),
    appNamesOf(session),
  ]);
  return { permissions, appNames };
};

/** Why the permissions can't be shown; nothing once they can. */
const HeldNotLoaded = ({
  held,
}: {
  held: Loaded<HeldPermissions> | undefined;
}) => {
  if (held === undefined || held.state === "ready") {
    return null;
  }
  const why =
    held.state === "offline"
      ? "Grasp can't be reached right now. Try again in a moment."
      : held.message;
  return (
    <ErrorText>{`Which Apps and agents hold permissions: ${why}`}</ErrorText>
  );
};

const Connections = () => {
  const { catalog, connections, held } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { connection, connectionError } = Route.useSearch();
  const names = new Map(
    catalog.state === "ready"
      ? catalog.data.entries.map(({ source, id, name }) => [
          `${source}:${id}`,
          name,
        ])
      : []
  );
  // The entries people are offered: an admin sees hidden ones too, marked;
  // anyone else isn't listed them at all. Unknown while the catalog isn't
  // read, and then core alone says.
  const offered =
    catalog.state === "ready"
      ? new Set(
          catalog.data.entries
            .filter((entry) => entry.offered)
            .map(({ source, id }) => `${source}:${id}`)
        )
      : undefined;
  const listed = connections.state === "ready" ? connections.data : [];
  // Only a connection the page lists: anyone can put an ID in a link.
  const connected =
    connection !== undefined && listed.some(({ id }) => id === connection);
  return (
    <main className="flex max-w-4xl flex-col gap-8 p-6">
      <h1 className="text-2xl font-medium">Connections</h1>
      {connected ? <output className="text-sm">Connected.</output> : null}
      {connectionError === undefined ? null : (
        <ErrorText>{connectionErrorMessage(connectionError)}</ErrorText>
      )}
      <HeldNotLoaded held={held} />
      <section aria-labelledby="mine" className="flex flex-col gap-3">
        <h2 className="text-lg font-medium" id="mine">
          My connections
        </h2>
        <NotLoaded page={connections} />
        {connections.state === "ready" ? (
          <ConnectionList
            connections={listed.filter(({ scope }) => scope === "personal")}
            names={names}
            offered={offered}
            held={held}
            identity={identity}
            empty="You haven't connected an account of your own yet."
          />
        ) : null}
      </section>
      <section aria-labelledby="shared" className="flex flex-col gap-3">
        <h2 className="text-lg font-medium" id="shared">
          Shared connections
        </h2>
        <NotLoaded page={connections} />
        {connections.state === "ready" ? (
          <ConnectionList
            connections={listed.filter(({ scope }) => scope === "shared")}
            names={names}
            offered={offered}
            held={held}
            identity={identity}
            empty="Your organization has no shared connections yet."
          />
        ) : null}
      </section>
      <section aria-labelledby="catalog" className="flex flex-col gap-3">
        <h2 className="text-lg font-medium" id="catalog">
          Connect
        </h2>
        <NotLoaded page={catalog} />
        {catalog.state === "ready" ? (
          <Catalog catalog={catalog.data} identity={identity} />
        ) : null}
      </section>
    </main>
  );
};

export const Route = createFileRoute("/_shell/connections")({
  validateSearch: (
    search: Record<string, unknown>
  ): { connection?: string; connectionError?: string } => ({
    ...(typeof search.connection === "string" && {
      connection: search.connection,
    }),
    ...(typeof search.connectionError === "string" && {
      connectionError: search.connectionError,
    }),
  }),
  // Each part is read on its own, and says on its own why it failed: one
  // read that fails or hangs leaves the others. Permissions only for those
  // who may list them (admins and builders).
  loader: async ({ context: { core, identity } }) => {
    const [catalog, connections, held] = await Promise.all([
      loadFromCore(
        core,
        async (session) => await session.connections.catalog()
      ),
      loadFromCore(core, async (session) => await session.connections.list()),
      canBuild(identity.role) ? loadFromCore(core, heldPermissions) : undefined,
    ]);
    return { catalog, connections, held };
  },
  component: Connections,
});
