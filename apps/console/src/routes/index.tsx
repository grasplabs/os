import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { fetchClientGrid, fetchGridLive } from "../clients/functions.ts";
import type { GridRow, LiveStatus, Reach } from "../clients/grid.ts";
import { formatTime } from "../releases/format.ts";
import type { ClientDriftState } from "../rollout/drift.ts";

type BadgeVariant = "secondary" | "destructive" | "outline";

/** A drift state, as its badge says it. */
const driftBadges: Readonly<
  Record<ClientDriftState, { label: string; variant: BadgeVariant }>
> = {
  in_sync: { label: "in sync", variant: "secondary" },
  drifted: { label: "drifted", variant: "destructive" },
  split: { label: "split", variant: "destructive" },
  off_pin: { label: "off its pin", variant: "destructive" },
  unknown: { label: "unknown", variant: "outline" },
};

const reachBadges: Readonly<
  Record<Reach, { label: string; variant: BadgeVariant }>
> = {
  reachable: { label: "reachable", variant: "secondary" },
  unreachable: { label: "unreachable", variant: "destructive" },
  no_route: { label: "no route", variant: "destructive" },
  unknown: { label: "unknown", variant: "outline" },
};

/** Shared secrets, as their badge says them. */
const secretsBadge = (
  current: boolean | null
): { label: string; variant: BadgeVariant } => {
  if (current === null) {
    return { label: "unknown", variant: "outline" };
  }
  return current
    ? { label: "current", variant: "secondary" }
    : { label: "behind", variant: "destructive" };
};

const usd = new Intl.NumberFormat("en", {
  style: "currency",
  currency: "USD",
});

const percent = new Intl.NumberFormat("en", {
  style: "percent",
  maximumFractionDigits: 1,
});

const dashboard = (accountId: string): string =>
  `https://dash.cloudflare.com/${accountId}`;

/** The last day's errors, in words: unknown, none asked, or their share. */
const errorsWords = (day: LiveStatus["day"]): string => {
  if (day === null) {
    return "errors unknown (24 h)";
  }
  if (day.requests === 0) {
    return "no requests (24 h)";
  }
  return `${percent.format(day.errors / day.requests)} errors (24 h)`;
};

const Health = ({ live }: { live: LiveStatus }) => {
  const reach = reachBadges[live.reach];
  return (
    <div className="flex flex-col gap-1">
      <Badge variant={reach.variant}>{reach.label}</Badge>
      <span className="text-muted-foreground text-xs">
        {errorsWords(live.day)}
      </span>
    </div>
  );
};

const Cost = ({ cost }: { cost: LiveStatus["costUsd"] }) =>
  cost === null ? (
    <span className="text-muted-foreground">unknown</span>
  ) : (
    <div className="flex flex-col">
      <span>{usd.format(cost.workers + cost.ai)}</span>
      <span className="text-muted-foreground text-xs">
        {`AI ${usd.format(cost.ai)}`}
      </span>
    </div>
  );

const Links = ({ row }: { row: GridRow }) => (
  <div className="flex flex-col gap-1 text-sm">
    {row.hostname === null ? null : (
      <>
        <a
          href={`https://${row.hostname}`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-4 hover:underline"
        >
          Deployment
        </a>
        <a
          href={`https://${row.hostname}/activity`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-4 hover:underline"
        >
          Activity
        </a>
      </>
    )}
    <a
      href={dashboard(row.accountId)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-4 hover:underline"
    >
      Cloudflare
    </a>
  </div>
);

/**
 * A row's live columns: read (`LiveStatus`), still being read
 * (`reading`), or not read (`failed`); null for a client that isn't active.
 */
type LiveCell = LiveStatus | "reading" | "failed" | null;

/** Four cells saying the live columns aren't there yet, or won't be. */
const Pending = ({ live }: { live: "reading" | "failed" }) => {
  const words = live === "reading" ? "reading…" : "unknown";
  return (
    <>
      <TableCell>
        <span className="text-muted-foreground">{words}</span>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground">{words}</span>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground">{words}</span>
      </TableCell>
      <TableCell>
        <span className="text-muted-foreground">{words}</span>
      </TableCell>
    </>
  );
};

const LiveCells = ({ live }: { live: LiveCell }) => {
  if (live === null) {
    return (
      <>
        <TableCell />
        <TableCell />
        <TableCell />
        <TableCell />
      </>
    );
  }
  if (live === "reading" || live === "failed") {
    return <Pending live={live} />;
  }
  const drift = driftBadges[live.drift];
  const secrets = secretsBadge(live.sharedSecretsCurrent);
  return (
    <>
      <TableCell>
        <Badge variant={drift.variant}>{drift.label}</Badge>
      </TableCell>
      <TableCell>
        <Badge variant={secrets.variant}>{secrets.label}</Badge>
      </TableCell>
      <TableCell>
        <Health live={live} />
      </TableCell>
      <TableCell>
        <Cost cost={live.costUsd} />
      </TableCell>
    </>
  );
};

const Row = ({ row, live }: { row: GridRow; live: LiveCell }) => (
  <TableRow>
    <TableCell>
      <div className="flex flex-col">
        <Link
          to="/clients/$clientId"
          params={{ clientId: row.id }}
          className="font-mono underline-offset-4 hover:underline"
        >
          {row.id}
        </Link>
        <span className="text-muted-foreground text-xs">{row.name}</span>
      </div>
    </TableCell>
    <TableCell>{row.status}</TableCell>
    <TableCell>
      <div className="flex flex-col">
        <span className="font-mono">{row.release ?? ""}</span>
        {row.pinnedReleaseId === null ? null : (
          <span className="text-muted-foreground text-xs">
            {`pinned to ${row.pinnedReleaseId}`}
          </span>
        )}
      </div>
    </TableCell>
    <TableCell>{row.ring}</TableCell>
    <TableCell>
      {row.lastDeploy === null ? (
        <span className="text-muted-foreground">none</span>
      ) : (
        <div className="flex flex-col">
          <span>{formatTime(row.lastDeploy.at)}</span>
          <span className="text-muted-foreground text-xs">
            {`${row.lastDeploy.status}, ${row.lastDeploy.releaseId}`}
          </span>
        </div>
      )}
    </TableCell>
    <LiveCells live={live} />
    <TableCell>
      <Links row={row} />
    </TableCell>
  </TableRow>
);

/** The live columns, by client id, read once the page shows; null while reading, `failed` if it did. */
const readLive = async (): Promise<Record<string, LiveStatus> | "failed"> => {
  try {
    return await fetchGridLive();
  } catch {
    return "failed";
  }
};

const Clients = () => {
  const rows = Route.useLoaderData();
  const [live, setLive] = useState<
    Record<string, LiveStatus> | "failed" | null
  >(null);
  useEffect(() => {
    let current = true;
    void (async () => {
      const read = await readLive();
      // A page left before its answer came doesn't take it.
      if (current) {
        setLive(read);
      }
    })();
    return () => {
      current = false;
    };
  }, []);
  const liveOf = (row: GridRow): LiveCell => {
    if (row.status !== "active") {
      return null;
    }
    if (live === null) {
      return "reading";
    }
    return live === "failed" ? "failed" : (live[row.id] ?? "failed");
  };
  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-medium">Clients</h1>
        <Link to="/clients/new" className={buttonVariants()}>
          New client
        </Link>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground">No clients yet.</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Release</TableHead>
                <TableHead>Ring</TableHead>
                <TableHead>Last deploy (UTC)</TableHead>
                <TableHead>Drift</TableHead>
                <TableHead>Shared secrets</TableHead>
                <TableHead>Health</TableHead>
                <TableHead>Cost this month</TableHead>
                <TableHead>Links</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <Row key={row.id} row={row} live={liveOf(row)} />
              ))}
            </TableBody>
          </Table>
          <p className="text-muted-foreground text-sm">
            Drift, shared secrets, health and cost are read from each active
            client&apos;s account after the page shows, and kept for a minute.
            Cost is an estimate for the calendar month: its Workers Paid plan
            with requests and CPU time past what it includes (which resets on
            its billing cycle, not the 1st), and AI Gateway spend. Storage (D1,
            R2) and Durable Objects aren&apos;t in it.
          </p>
        </>
      )}
    </main>
  );
};

export const Route = createFileRoute("/")({
  loader: async () => await fetchClientGrid(),
  component: Clients,
});
