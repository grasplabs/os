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
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SourceBadge } from "./source-badge.tsx";
import { toolRules, withAllowed, withRead } from "./tool-choices.ts";
import type { AllowedTool } from "./tool-choices.ts";
import { useChange } from "./use-change.ts";

// What can be connected, to search and connect from. A native provider
// starts its OAuth flow, for the person themselves or, for an admin, for
// everyone; a Composio toolkit starts Composio's, once an admin has chosen
// its tools and consented to Composio holding its tokens. Admins also
// choose which entries are offered at all. Core and connect check every
// step: the page leaves out only what the role can't do.

type Entry = OfferedCatalog["entries"][number];

/** Where every flow sends the browser back to: this page. */
export const returnTo = "/connections";

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
export const goTo = (started: { url: string } | undefined): void => {
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
  const { t } = useLingui();
  const { name } = entry;
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
          aria-label={t`Connect ${name}`}
          onClick={() => {
            void start("personal");
          }}
        >
          <Trans>Connect</Trans>
        </Button>
        {admin ? (
          <Button
            variant="outline"
            disabled={busy || !entry.offered}
            aria-label={t`Connect ${name} for everyone`}
            onClick={() => {
              void start("shared");
            }}
          >
            <Trans>Connect for everyone</Trans>
          </Button>
        ) : null}
      </div>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * One tool of the toolkit: whether to allow it and, once allowed, whether
 * it only reads (tool-choices.ts).
 */
const ToolChoice = ({
  tool,
  choice,
  onAllow,
  onRead,
}: {
  tool: CatalogTool;
  choice: AllowedTool | undefined;
  onAllow: (allow: boolean) => void;
  onRead: (read: boolean) => void;
}) => {
  const { t } = useLingui();
  const { name } = tool;
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox checked={choice !== undefined} onCheckedChange={onAllow} />
        {tool.name}
      </label>
      {choice === undefined ? null : (
        <div className="text-muted-foreground flex items-center gap-2">
          <Checkbox
            checked={choice.read}
            aria-label={t`${name} is read-only`}
            onCheckedChange={onRead}
          />
          <span aria-hidden="true">
            <Trans>Read-only</Trans>
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Connecting a Composio toolkit: the admin picks the tools to allow, says
 * which of them only read, reads what they consent to, and consents by
 * connecting. A read-only tool runs without asking; a call of any other is
 * a side effect, which waits for its person to confirm it wherever a
 * person is there (chat, an App they use), and which a workflow's run
 * makes as a step.
 */
const ComposioConnect = ({ entry }: { entry: Entry }) => {
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<CatalogTool[]>();
  const [allowed, setAllowed] = useState<AllowedTool[]>([]);
  const { t } = useLingui();
  const { name } = entry;
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
            tools: toolRules(allowed),
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
          <Button disabled={!entry.offered} aria-label={t`Connect ${name}`} />
        }
      >
        <Trans>Connect</Trans>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Connect {name} through Composio</Trans>
          </DialogTitle>
          {/* The consent stays as written: core keeps a hash of the exact
              text consented to (connection-list.tsx shows it again). */}
          <DialogDescription>{composioConsentText}</DialogDescription>
        </DialogHeader>
        <fieldset className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          <legend className="mb-2 text-sm font-medium">
            <Trans>Tools to allow</Trans>
          </legend>
          <p className="text-muted-foreground text-sm">
            <Trans>
              Read-only is ticked where Composio says a tool only reads; Grasp
              doesn&apos;t check that. A read-only tool runs without asking. A
              call of any other tool from chat, or from a person using an App,
              waits for that person to confirm it; a workflow&apos;s run makes
              it as one of its steps. Mark a tool read-only only if it changes
              nothing: marked wrongly, it changes things without asking.
            </Trans>
          </p>
          {tools === undefined && busy ? (
            <p className="text-muted-foreground text-sm">
              <Trans>Loading its tools…</Trans>
            </p>
          ) : null}
          {tools?.map((tool) => (
            <ToolChoice
              key={tool.name}
              tool={tool}
              choice={allowed.find((choice) => choice.name === tool.name)}
              onAllow={(allow) => {
                setAllowed((current) => withAllowed(current, tool, allow));
              }}
              onRead={(read) => {
                setAllowed((current) => withRead(current, tool.name, read));
              }}
            />
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
            <Trans>Consent and connect</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** An admin's switch for whether people are offered `entry`. */
const OfferSwitch = ({ entry, staff }: { entry: Entry; staff: boolean }) => {
  const { busy, failure, change } = useChange();
  const { t } = useLingui();
  const { name } = entry;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        <Switch
          checked={entry.offered}
          // Staff are admins, but core leaves the choice to the client's.
          disabled={busy || staff}
          aria-label={t`Offer ${name}`}
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
        <span aria-hidden="true">
          <Trans>Offered</Trans>
        </span>
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
  const { t } = useLingui();
  const { toolCount } = entry;
  let connect: ReactNode = (
    <p className="text-muted-foreground text-sm">
      <Trans>An admin connects this for everyone.</Trans>
    </p>
  );
  if (identity.staff) {
    // Core refuses staff every connection; the catalog says so once.
    connect = null;
  } else if (entry.source === "native" && provider.success) {
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
        {entry.offered ? null : (
          <Badge variant="outline">
            <Trans>Not offered</Trans>
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground text-sm">
        {[
          ...entry.categories,
          t`${plural(toolCount, { one: "# tool", other: "# tools" })}`,
        ].join(" · ")}
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
  const { t } = useLingui();
  const count = shown.length;
  const total = matching.length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex max-w-sm flex-col gap-1 text-sm">
        <label htmlFor={searchId}>
          <Trans>Search</Trans>
        </label>
        <Input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
      </div>
      {identity.staff ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            Grasp staff can&apos;t connect accounts or change what is offered
            here: that is for the organization&apos;s own people.
          </Trans>
        </p>
      ) : null}
      {catalog.composio === "unavailable" ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            Composio&apos;s toolkits can&apos;t be listed right now. Try again
            shortly.
          </Trans>
        </p>
      ) : null}
      {matching.length > shown.length ? (
        <p className="text-muted-foreground text-sm">
          {t`Showing the first ${count} of ${total}. Refine your search to find others.`}
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Nothing matches.</Trans>
        </p>
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
