import {
  composioConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type { ListedConnection, OAuthProvider } from "@grasp-os/shared/connect";
import type { Permission } from "@grasp-os/shared/permissions";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { goTo, returnTo } from "./catalog.tsx";
import { SourceBadge } from "./source-badge.tsx";
import { useChange } from "./use-change.ts";

// The person's connections and the shared ones, as core lists them: what
// each reaches, who connected it, and, for admins and builders, which Apps
// and agents hold a permission for it. Connect and core check every
// reconnect, disconnect and revoke; the page leaves out only what the role
// can't do.

/** Every permission the person may list, and the Apps' names. */
export interface HeldPermissions {
  permissions: Permission[];
  /** App names by ID; an ID stands in for an App not listed here. */
  appNames: ReadonlyMap<string, string>;
}

const statusText: Record<ListedConnection["status"], string> = {
  active: "Active",
  needs_reauth: "Needs connecting again",
  disconnected: "Disconnected",
};

const scopeText: Record<ListedConnection["scope"], string> = {
  personal: "Personal: only you can use it",
  shared: "Shared: your organization uses it through permissions",
};

/** An ISO 8601 time as a date for people. */
const dateOf = (iso: string): string => new Date(iso).toLocaleDateString();

/** Who holds a permission, for people: the App's name, or the agent. */
const holderOf = (
  { subject }: Permission,
  appNames: ReadonlyMap<string, string>
): string =>
  subject.type === "app"
    ? `App ${appNames.get(subject.appId) ?? subject.appId}`
    : `Agent ${subject.agentId}`;

const HolderItem = ({
  permission,
  holder,
  mayRevoke,
}: {
  permission: Permission;
  holder: string;
  mayRevoke: boolean;
}) => {
  const { busy, failure, change } = useChange();
  const { object } = permission;
  const resource =
    object.type === "connection" && object.resource !== undefined
      ? object.resource
      : "the whole connection";
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span>
          {holder}: {permission.actions.join(", ")} on {resource}
        </span>
        {mayRevoke ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label={`Revoke ${holder}'s permission`}
            onClick={() => {
              void change(
                async (session) =>
                  await session.permissions.revoke(permission.id)
              );
            }}
          >
            Revoke
          </Button>
        ) : null}
      </div>
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

/**
 * The Apps and agents that can use the connection `id` now: those with an
 * active permission for it. One only asked for allows nothing yet.
 */
const Holders = ({
  id,
  held,
  mayRevoke,
}: {
  id: string;
  held: HeldPermissions;
  mayRevoke: boolean;
}) => {
  const holding = held.permissions.filter(
    ({ object, status }) =>
      object.type === "connection" &&
      object.connectionId === id &&
      status === "active"
  );
  return (
    <div className="flex flex-col gap-1 text-sm">
      <h4 className="font-medium">Apps and agents with a permission</h4>
      {holding.length === 0 ? (
        <p className="text-muted-foreground">None.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {holding.map((permission) => (
            <HolderItem
              key={permission.id}
              permission={permission}
              holder={holderOf(permission, held.appNames)}
              mayRevoke={mayRevoke}
            />
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * A Composio connection's consent: who gave it, and the tools they allowed.
 * The text is the consent as this release words it, and says so; the audit
 * log keeps the SHA-256 of the exact text they were shown
 * (`connection.consent`).
 */
const ConsentRecord = ({ connection }: { connection: ListedConnection }) => (
  <div className="flex flex-col gap-1 text-sm">
    <h4 className="font-medium">Consent</h4>
    <p>
      {connection.connectedByName ?? "An admin"} consented to this before
      connecting it:
    </p>
    <blockquote className="text-muted-foreground border-l-2 pl-3">
      {composioConsentText}
    </blockquote>
    <p className="text-muted-foreground">
      This is the consent as Grasp words it now. The audit log keeps a hash of
      the exact text they were shown.
    </p>
    <p>
      Tools allowed:{" "}
      {connection.tools === undefined || connection.tools.length === 0
        ? "none recorded"
        : connection.tools.join(", ")}
    </p>
  </div>
);

const Detail = ({ term, children }: { term: string; children: string }) => (
  <div className="flex gap-2">
    <dt className="text-muted-foreground">{term}</dt>
    <dd>{children}</dd>
  </div>
);

/**
 * Starts the provider's flow again for a connection whose access ran out.
 * Finished with the account it holds, it is the same connection again,
 * with every permission on it; connect decides that from the account the
 * provider names, never from this page.
 */
const Reconnect = ({
  connection,
  provider,
  label,
}: {
  connection: ListedConnection;
  provider: OAuthProvider;
  label: string;
}) => {
  const { busy, failure, run } = useCoreAction();
  const start = async (): Promise<void> => {
    goTo(
      await run(
        async (session) =>
          await session.connections.start({
            provider,
            scope: connection.scope,
            returnTo,
          })
      )
    );
  };
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-sm">
        Its access ran out. Reconnect it with the same account: Apps and agents
        keep their permissions for it.
      </p>
      <Button
        className="self-start"
        disabled={busy}
        aria-label={`Reconnect ${label}`}
        onClick={() => {
          void start();
        }}
      >
        Reconnect
      </Button>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * What a connection whose access ran out says to someone who can't
 * reconnect it: why not, and who can, if anyone. `known` is whether its
 * provider is one this release starts a flow for, and `offered` whether
 * the organization offers it: core refuses to start a flow for one it
 * doesn't, whoever asks.
 */
const ranOutText = (
  known: boolean,
  offered: boolean,
  staff: boolean
): string => {
  if (!known) {
    return "Its access ran out, and it can't be reconnected here.";
  }
  if (!offered) {
    return "Its access ran out. An admin must offer this connector again before it can be reconnected.";
  }
  return staff
    ? "Its access ran out. Grasp staff can't reconnect it: an admin of the organization can."
    : "Its access ran out. An admin of your organization can reconnect it.";
};

const ConnectionItem = ({
  connection,
  name,
  offered,
  held,
  identity,
}: {
  connection: ListedConnection;
  name: string;
  /** Whether people are offered its catalog entry. */
  offered: boolean;
  held: HeldPermissions | undefined;
  identity: Identity;
}) => {
  const { busy, failure, change } = useChange();
  const [confirming, setConfirming] = useState(false);
  const admin = isAdmin(identity.role);
  // Only the owner sees a personal connection here, and admins disconnect
  // shared ones: connect checks both.
  const mayDisconnect = connection.scope === "personal" || admin;
  const provider = oauthProviderSchema.safeParse(connection.provider);
  // Whoever may disconnect it may reconnect it, but never Grasp staff, and
  // only while its connector is offered.
  const reconnectable =
    connection.source === "native" &&
    provider.success &&
    offered &&
    mayDisconnect &&
    !identity.staff;
  const label =
    connection.accountName === null
      ? name
      : `${name} (${connection.accountName})`;
  const connectedBy =
    connection.connectedBy === identity.userId
      ? "You"
      : (connection.connectedByName ?? "Someone no longer here");
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{label}</h3>
        <SourceBadge source={connection.source} />
      </div>
      <dl className="flex flex-col gap-1 text-sm">
        <Detail term="Status">{statusText[connection.status]}</Detail>
        <Detail term="Scope">{scopeText[connection.scope]}</Detail>
        <Detail term="Account">
          {connection.accountName ?? "Not named by the provider"}
        </Detail>
        <Detail term="Connected by">{connectedBy}</Detail>
        <Detail term="Connected on">{dateOf(connection.createdAt)}</Detail>
      </dl>
      {connection.status === "needs_reauth" && reconnectable ? (
        <Reconnect
          connection={connection}
          provider={provider.data}
          label={label}
        />
      ) : null}
      {connection.status === "needs_reauth" && !reconnectable ? (
        <p className="text-muted-foreground text-sm">
          {ranOutText(
            connection.source === "native" && provider.success,
            offered,
            identity.staff
          )}
        </p>
      ) : null}
      {connection.source === "composio" ? (
        <ConsentRecord connection={connection} />
      ) : null}
      {held === undefined ? null : (
        <Holders
          id={connection.id}
          held={held}
          mayRevoke={admin && !identity.staff}
        />
      )}
      {mayDisconnect ? (
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogTrigger
            render={
              <Button
                className="self-start"
                variant="destructive"
                disabled={busy}
                aria-label={`Disconnect ${label}`}
              />
            }
          >
            Disconnect
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Disconnect {label}?</DialogTitle>
              <DialogDescription>
                Its tokens are deleted, every App and agent loses it, and
                actions waiting on it are dropped. Connect it again to use it
                again.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter showCloseButton>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  void change(
                    async (session) =>
                      await session.connections.disconnect(connection.id)
                  );
                }}
              >
                Disconnect
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </li>
  );
};

export const ConnectionList = ({
  connections,
  names,
  offered,
  held,
  identity,
  empty,
}: {
  connections: ListedConnection[];
  /** Catalog names, keyed `source:id`; the provider's ID stands in. */
  names: ReadonlyMap<string, string>;
  /**
   * The catalog entries people are offered, keyed like `names`; undefined
   * while the catalog isn't read, when every entry counts as offered.
   */
  offered: ReadonlySet<string> | undefined;
  /** Undefined for someone who can't list permissions. */
  held: Loaded<HeldPermissions> | undefined;
  identity: Identity;
  empty: string;
}) =>
  connections.length === 0 ? (
    <p className="text-muted-foreground text-sm">{empty}</p>
  ) : (
    <ul className="flex flex-col gap-3">
      {connections.map((connection) => (
        <ConnectionItem
          key={connection.id}
          connection={connection}
          name={
            names.get(`${connection.source}:${connection.provider}`) ??
            connection.provider
          }
          offered={
            offered?.has(`${connection.source}:${connection.provider}`) ?? true
          }
          held={held?.state === "ready" ? held.data : undefined}
          identity={identity}
        />
      ))}
    </ul>
  );
