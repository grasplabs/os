import { releaseIdSchema } from "@grasp-os/shared/release";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import type { Change, WorkerDiff } from "../../releases/diff.ts";
import { formatTime } from "../../releases/format.ts";
import { fetchComparison } from "../../releases/functions.ts";

const changeVariant = {
  added: "default",
  removed: "destructive",
  changed: "secondary",
} as const;

const ChangeList = ({
  title,
  changes,
}: {
  title: string;
  changes: Change[];
}) => (
  <section className="flex flex-col gap-2">
    <h3 className="font-medium">{title}</h3>
    {changes.length === 0 ? (
      <p className="text-muted-foreground text-sm">No changes</p>
    ) : (
      <ul className="flex flex-col gap-1 text-sm">
        {changes.map((change) => (
          <li key={change.name} className="flex flex-wrap items-center gap-2">
            <Badge variant={changeVariant[change.change]}>
              {change.change}
            </Badge>
            <span className="font-mono break-all">{change.name}</span>
            {change.from === undefined && change.to === undefined ? null : (
              <span className="text-muted-foreground font-mono">
                {`${change.from ?? "none"} to ${change.to ?? "none"}`}
              </span>
            )}
          </li>
        ))}
      </ul>
    )}
  </section>
);

const WorkerChanges = ({ worker }: { worker: WorkerDiff }) => (
  <Card>
    <CardHeader>
      <CardTitle>{worker.worker}</CardTitle>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-4">
        <ChangeList title="Code" changes={worker.modules} />
        <ChangeList title="Bindings" changes={worker.bindings} />
        <ChangeList title="Settings" changes={worker.settings} />
        <ChangeList title="D1 migrations" changes={worker.migrations} />
        <ChangeList title="Static assets" changes={worker.assets} />
      </div>
    </CardContent>
  </Card>
);

const Comparison = () => {
  const { from, to, diff, between, moreBetween } = Route.useLoaderData();
  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <Link
          to="/releases"
          className="text-muted-foreground text-sm underline-offset-4 hover:underline"
        >
          Releases
        </Link>
        <h1 className="text-2xl font-medium">
          <span className="font-mono">{from.id}</span> to{" "}
          <span className="font-mono">{to.id}</span>
        </h1>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Release notes</CardTitle>
        </CardHeader>
        <CardContent>
          {between.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No releases in between
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {between.map((release) => (
                <li key={release.id} className="flex flex-wrap gap-2">
                  <Link
                    to="/releases/$releaseId"
                    params={{ releaseId: release.id }}
                    className="font-mono underline-offset-4 hover:underline"
                  >
                    {release.id}
                  </Link>
                  <span>{release.notes}</span>
                  <span className="text-muted-foreground">
                    {formatTime(release.builtAt)}
                  </span>
                </li>
              ))}
              {moreBetween > 0 ? (
                <li className="text-muted-foreground">
                  {`and ${moreBetween} more`}
                </li>
              ) : null}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Platform</CardTitle>
        </CardHeader>
        <CardContent>
          <ChangeList
            title="Compatibility date and packages"
            changes={diff.platform}
          />
        </CardContent>
      </Card>
      {diff.workers.map((worker) => (
        <WorkerChanges key={worker.worker} worker={worker} />
      ))}
    </main>
  );
};

/** The two releases to compare, as the URL names them. */
const searchParam = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const Route = createFileRoute("/releases/diff")({
  validateSearch: (search: Record<string, unknown>) => ({
    from: searchParam(search.from),
    to: searchParam(search.to),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const from = releaseIdSchema.safeParse(deps.from);
    const to = releaseIdSchema.safeParse(deps.to);
    const comparison =
      from.success && to.success
        ? await fetchComparison({ data: { from: from.data, to: to.data } })
        : null;
    if (comparison === null) {
      throw notFound();
    }
    return comparison;
  },
  component: Comparison,
});
