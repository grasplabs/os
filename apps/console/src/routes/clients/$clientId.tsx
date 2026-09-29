import { newClientIdSchema } from "@grasp-os/shared/router";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  createFileRoute,
  Link,
  notFound,
  useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";

import {
  confirmClientWorkersPaid,
  fetchNewClientOptions,
  fetchProvisioning,
  retryClient,
} from "../../provision/functions.ts";
import type { ProvisioningView } from "../../provision/queries.ts";
import { useProvisionAction } from "../../provision/use-action.ts";
import { formatTime } from "../../releases/format.ts";
import { ClientRelease } from "../../rollout/client-release.tsx";

/** How often the page reads the run again while it's working on its own. */
const refreshMs = 5000;

const dashboard = (accountId: string): string =>
  `https://dash.cloudflare.com/${accountId}`;

/** Whether the client runs the shared secrets in Secrets Store now, in words; "" when unknown. */
const sharedSecretsOf = (current: boolean | null): string => {
  if (current === null) {
    return "";
  }
  return current
    ? "current with Secrets Store"
    : "behind Secrets Store: a secrets rollout would bring it up to date";
};

const Facts = ({ view }: { view: ProvisioningView }) => {
  const facts: [string, string][] = [
    ["Hostname", view.hostname ?? "no CLIENT_DOMAIN set"],
    ["Cloudflare account", view.client?.accountId ?? "not yet"],
    ["Ring", view.client === null ? "" : String(view.client.ring)],
    ["Release", view.deploy?.releaseId ?? "not deployed yet"],
    ["Shared secrets", sharedSecretsOf(view.sharedSecretsCurrent)],
    ["Created by", view.client?.createdBy ?? ""],
    [
      "Created (UTC)",
      view.client === null ? "" : formatTime(view.client.createdAt),
    ],
  ];
  return (
    <dl className="flex flex-col gap-1 text-sm">
      {/* Facts the client has none of yet (before it's recorded) are left out. */}
      {facts
        .filter(([, value]) => value !== "")
        .map(([term, value]) => (
          <div key={term} className="flex flex-wrap gap-x-4">
            <dt className="text-muted-foreground w-48">{term}</dt>
            <dd className="font-mono break-all">{value}</dd>
          </div>
        ))}
    </dl>
  );
};

/** What staff do while the run waits for Workers Paid. */
const WorkersPaid = ({ view }: { view: ProvisioningView }) => {
  const router = useRouter();
  const { busy, failure, run } = useProvisionAction();
  const accountId = view.client?.accountId ?? "";
  const confirm = () => {
    void run(async () => {
      const result = await confirmClientWorkersPaid({
        data: { clientId: view.clientId },
      });
      await router.invalidate({ sync: true });
      return result;
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        <li>
          <a
            href={dashboard(accountId)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
          >
            Open the account in the Cloudflare dashboard
          </a>{" "}
          and upgrade it to Workers Paid.
        </li>
        <li>Turn on R2 in the same account: the deploy creates buckets.</li>
        <li>Confirm below; the deploy starts at once.</li>
      </ol>
      {view.workersPaidConfirmed ? (
        // Confirmed already: the run goes on by itself, and the page follows.
        <p className="text-sm">Confirmed, waiting for the run.</p>
      ) : (
        <div className="flex items-center gap-4">
          <Button disabled={busy} onClick={confirm}>
            Workers Paid is on
          </Button>
          {failure === null ? null : (
            <p role="alert" className="text-destructive text-sm">
              {failure}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

/** Why the run stopped, and resuming it. */
const Failed = ({ view }: { view: ProvisioningView }) => {
  const router = useRouter();
  const { busy, failure, run } = useProvisionAction();
  const retry = () => {
    void run(async () => {
      const result = await retryClient({ data: { clientId: view.clientId } });
      await router.invalidate({ sync: true });
      return result;
    });
  };
  if (view.client === null) {
    // It stopped before it recorded the client: nothing to resume.
    return (
      <div className="flex flex-col gap-4 text-sm">
        <p>{`The run stopped: ${view.stopped?.error ?? "before it recorded the client"}.`}</p>
        <p className="text-muted-foreground">
          Fix what it says, or pick another account, and{" "}
          <Link to="/clients/new" className="underline underline-offset-4">
            start again
          </Link>{" "}
          with the same client id.
        </p>
      </div>
    );
  }
  let reason = "its run is gone (Workflows keeps a run for a while only)";
  if (view.stopped !== null) {
    reason = `${view.stopped.step} step: ${view.stopped.error}`;
  } else if (view.run === "terminated") {
    reason = "it was ended outside the console";
  } else if (view.run !== null && view.run !== "gone") {
    reason = `it failed after its retries${
      view.deploy === null || view.deploy.error === null
        ? ""
        : ` (${view.deploy.error})`
    }`;
  }
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>{`The run stopped: ${reason}.`}</p>
      <p className="text-muted-foreground">
        Fix what it says, then resume: it picks up from the deploy if it got
        that far, and makes nothing twice.
      </p>
      <div className="flex items-center gap-4">
        <Button disabled={busy} onClick={retry}>
          Resume
        </Button>
        {failure === null ? null : (
          <p role="alert" className="text-destructive">
            {failure}
          </p>
        )}
      </div>
    </div>
  );
};

const Progress = ({ view }: { view: ProvisioningView }) => {
  switch (view.phase) {
    case "account": {
      return (
        <p className="text-sm">
          Setting up: the Cloudflare account, then the client record.
        </p>
      );
    }
    case "workers_paid": {
      return <WorkersPaid view={view} />;
    }
    case "deploying": {
      return (
        <p className="text-sm">
          {`Deploying ${view.deploy?.releaseId ?? "the release"}: ${
            view.deploy?.step === null || view.deploy === null
              ? "starting"
              : `${view.deploy.step} done`
          }.`}
        </p>
      );
    }
    case "failed": {
      return <Failed view={view} />;
    }
    case "active": {
      return (
        <p className="text-sm">
          {`Live at https://${view.hostname ?? ""}, and passed its smoke check.`}
        </p>
      );
    }
    default: {
      return null;
    }
  }
};

/**
 * Phases the page follows, since they move on without the page: the run
 * works on its own, or (Workers Paid) goes on once staff confirm.
 */
const working: ReadonlySet<ProvisioningView["phase"]> = new Set([
  "account",
  "workers_paid",
  "deploying",
]);

const Client = () => {
  const { view, releases } = Route.useLoaderData();
  const router = useRouter();
  const following = working.has(view.phase);
  useEffect(() => {
    const timer = following
      ? setInterval(() => {
          void router.invalidate();
        }, refreshMs)
      : undefined;
    return () => {
      clearInterval(timer);
    };
  }, [following, router]);
  return (
    <main className="flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-medium">
          {view.client?.name ?? view.clientId}
        </h1>
        <Badge variant={view.phase === "failed" ? "destructive" : "secondary"}>
          {view.client?.status ?? "provisioning"}
        </Badge>
      </div>
      <Facts view={view} />
      <Card>
        <CardHeader>
          <CardTitle>Provisioning</CardTitle>
        </CardHeader>
        <CardContent>
          <Progress view={view} />
        </CardContent>
      </Card>
      {view.client?.status === "active" ? (
        <ClientRelease
          clientId={view.clientId}
          pinnedReleaseId={view.client.pinnedReleaseId}
          releases={releases}
        />
      ) : null}
    </main>
  );
};

/** A client id that names no client, nor a run for one. */
const NoSuchClient = () => {
  const { clientId } = Route.useParams();
  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-medium">No such client</h1>
      <p className="text-sm">{`There's no client ${clientId}.`}</p>
      <Link to="/" className="text-sm underline underline-offset-4">
        Back to clients
      </Link>
    </main>
  );
};

export const Route = createFileRoute("/clients/$clientId")({
  loader: async ({ params }) => {
    if (!newClientIdSchema.safeParse(params.clientId).success) {
      throw notFound();
    }
    const [view, { releases }] = await Promise.all([
      fetchProvisioning({ data: { clientId: params.clientId } }),
      fetchNewClientOptions(),
    ]);
    if (view === null) {
      throw notFound();
    }
    return { view, releases };
  },
  component: Client,
  notFoundComponent: NoSuchClient,
});
