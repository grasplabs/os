import {
  composioConsentText,
  oauthProviderSchema,
} from "@grasp-os/shared/connect";
import type {
  CatalogTool,
  ConnectionScope,
  OAuthProvider,
  OfferedCatalog,
} from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Input } from "@grasp-os/ui/components/input";
import { Switch } from "@grasp-os/ui/components/switch";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SourceBadge } from "./source-badge.tsx";
import { useChange } from "./use-change.ts";

// What can be connected, to search and connect from. A native provider
// starts its OAuth flow, for the person themselves or, for an admin, for
// everyone; a Composio toolkit starts Composio's, once an admin has chosen
// its tools and consented to Composio holding its tokens. Admins also
// choose which entries are offered at all. Core and connect check every
// step: the page leaves out only what the role can't do.

type Entry = OfferedCatalog["entries"][number];

/** Where every flow sends the browser back to: this page. */
const returnTo = "/connections";

/**
 * Most entries shown at once: Composio lists thousands of toolkits, so the
 * rest wait for a narrower search.
 */
const catalogShownMax = 50;

/** Whether `entry` matches what the person searched for. */
const matches = (entry: Entry, query: string): boolean => {
  const wanted = query.trim().toLowerCase();
  return [entry.name, entry.id, ...entry.categories].some((text) =>
    text.toLowerCase().includes(wanted)
  );
};

/** Sends the browser to the provider, once core started the flow. */
const goTo = (started: { url: string } | undefined): void => {
  if (started !== undefined) {
    window.location.assign(started.url);
  }
};

const NativeConnect = ({
  entry,
  provider,
  admin,
}: {
  entry: Entry;
  provider: OAuthProvider;
  admin: boolean;
}) => {
  const { busy, failure, run } = useCoreAction();
  const start = async (scope: ConnectionScope): Promise<void> => {
    goTo(
      await run(
        async (session) =>
          await session.connections.start({ provider, scope, returnTo })
      )
    );
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Button
          disabled={busy || !entry.offered}
          aria-label={`Connect ${entry.name}`}
          onClick={() => {
            void start("personal");
          }}
        >
          Connect
        </Button>
        {admin ? (
          <Button
            variant="outline"
            disabled={busy || !entry.offered}
            aria-label={`Connect ${entry.name} for everyone`}
            onClick={() => {
              void start("shared");
            }}
          >
            Connect for everyone
          </Button>
        ) : null}
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * Connecting a Composio toolkit: the admin picks the tools to allow, reads
 * what they consent to, and consents by connecting. Each tool is allowed
 * by name, so every call of it counts as a side effect and waits for its
 * person to confirm it.
 */
const ComposioConnect = ({ entry }: { entry: Entry }) => {
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<CatalogTool[]>();
  const [allowed, setAllowed] = useState<string[]>([]);
  const loadTools = async (): Promise<void> => {
    const listed = await run(
      async (session) =>
        await session.connections.catalogTools(entry.source, entry.id)
    );
    if (listed !== undefined) {
      setTools(listed);
    }
  };
  const connect = async (): Promise<void> => {
    goTo(
      await run(
        async (session) =>
          await session.connections.connectToolkit({
            toolkit: entry.id,
            tools: allowed,
            consent: composioConsentText,
            returnTo,
          })
      )
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && tools === undefined) {
          void loadTools();
        }
      }}
    >
      <DialogTrigger
        render={
          <Button
            disabled={!entry.offered}
            aria-label={`Connect ${entry.name}`}
          />
        }
      >
        Connect
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {entry.name} through Composio</DialogTitle>
          <DialogDescription>{composioConsentText}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          <legend className="mb-2 text-sm font-medium">Tools to allow</legend>
          {tools === undefined && busy ? (
            <p className="text-muted-foreground text-sm">Loading its tools…</p>
          ) : null}
          {tools?.map((tool) => (
            <label key={tool.name} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={allowed.includes(tool.name)}
                onCheckedChange={(checked) => {
                  setAllowed((current) =>
                    checked
                      ? [...current, tool.name]
                      : current.filter((name) => name !== tool.name)
                  );
                }}
              />
              {tool.name}
            </label>
          ))}
        </fieldset>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter showCloseButton>
          <Button
            disabled={busy || allowed.length === 0}
            onClick={() => {
              void connect();
            }}
          >
            Consent and connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** An admin's switch for whether people are offered `entry`. */
const OfferSwitch = ({ entry, staff }: { entry: Entry; staff: boolean }) => {
  const { busy, failure, change } = useChange();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        <Switch
          checked={entry.offered}
          // Staff are admins, but core leaves the choice to the client's.
          disabled={busy || staff}
          aria-label={`Offer ${entry.name}`}
          onCheckedChange={(offered) => {
            void change(async (session) => {
              await session.connections.setOffered(
                entry.source,
                entry.id,
                offered
              );
            });
          }}
        />
        <span aria-hidden="true">Offered</span>
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

const CatalogItem = ({
  entry,
  identity,
}: {
  entry: Entry;
  identity: Identity;
}) => {
  const admin = isAdmin(identity.role);
  const provider = oauthProviderSchema.safeParse(entry.id);
  let connect = (
    <p className="text-muted-foreground text-sm">
      An admin connects this for everyone.
    </p>
  );
  if (entry.source === "native" && provider.success) {
    connect = (
      <NativeConnect entry={entry} provider={provider.data} admin={admin} />
    );
  } else if (entry.source === "composio" && admin) {
    connect = <ComposioConnect entry={entry} />;
  }
  return (
    <li className="flex flex-col gap-2 border-b pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{entry.name}</h3>
        <SourceBadge source={entry.source} />
        {entry.offered ? null : <Badge variant="outline">Not offered</Badge>}
      </div>
      <p className="text-muted-foreground text-sm">
        {[...entry.categories, `${entry.toolCount} tools`].join(" · ")}
      </p>
      <div className="flex flex-wrap items-start gap-4">
        {connect}
        {admin ? <OfferSwitch entry={entry} staff={identity.staff} /> : null}
      </div>
    </li>
  );
};

export const Catalog = ({
  catalog,
  identity,
}: {
  catalog: OfferedCatalog;
  identity: Identity;
}) => {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const matching = catalog.entries.filter((entry) => matches(entry, query));
  const shown = matching.slice(0, catalogShownMax);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-w-sm flex-col gap-1 text-sm">
        <label htmlFor={searchId}>Search</label>
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      {catalog.composio === "unavailable" ? (
        <p className="text-muted-foreground text-sm">
          Composio&apos;s toolkits can&apos;t be listed right now. Try again
          shortly.
        </p>
      ) : null}
      {matching.length > shown.length ? (
        <p className="text-muted-foreground text-sm">
          {`Showing the first ${shown.length} of ${matching.length}. Refine your search to find others.`}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing matches.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {shown.map((entry) => (
            <CatalogItem
              key={`${entry.source}:${entry.id}`}
              entry={entry}
              identity={identity}
            />
          ))}
        </ul>
      )}
    </div>
  );
};
