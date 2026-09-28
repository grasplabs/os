import { releaseIdSchema } from "@grasp-os/shared/release";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { formatBytes, formatTime } from "../../releases/format.ts";
import { fetchRelease } from "../../releases/functions.ts";
import type { WorkerView } from "../../releases/queries.ts";

const Facts = ({ facts }: { facts: [string, string][] }) => (
  <dl className="flex flex-col gap-1 text-sm">
    {facts.map(([term, value]) => (
      <div key={term} className="flex flex-wrap gap-x-4">
        <dt className="text-muted-foreground w-48">{term}</dt>
        <dd className="font-mono break-all">{value}</dd>
      </div>
    ))}
  </dl>
);

const listed = (items: string[]): string => items.join(", ") || "none";

const WorkerCard = ({ worker }: { worker: WorkerView }) => (
  <Card>
    <CardHeader>
      <CardTitle>
        {worker.app}{" "}
        <span className="text-muted-foreground">({worker.name})</span>
      </CardTitle>
    </CardHeader>
    <CardContent>
      <div className="flex flex-col gap-4">
        <Facts
          facts={[
            ["Main module", worker.mainModule],
            ["Compatibility flags", listed(worker.compatibilityFlags)],
            ["Crons", listed(worker.crons)],
            ["Required secrets", listed(worker.requiredSecrets)],
            [
              "Durable Object migrations",
              listed(worker.durableObjectMigrations),
            ],
            ["Static assets", String(worker.assetCount)],
          ]}
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Module</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>SHA-256</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {worker.modules.map((module) => (
              <TableRow key={module.name}>
                <TableCell>
                  <span className="font-mono">{module.name}</span>
                </TableCell>
                <TableCell>{module.type}</TableCell>
                <TableCell>{formatBytes(module.size)}</TableCell>
                <TableCell>
                  <span className="font-mono">
                    {module.sha256.slice(0, 12)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {worker.d1Databases.map((database) => (
          <section key={database.binding} className="flex flex-col gap-2">
            <h3 className="font-medium">
              {`D1 ${database.binding} `}
              <span className="text-muted-foreground">
                {`(${database.databaseName}), ${database.migrations.length} migrations`}
              </span>
            </h3>
            <ul className="font-mono text-sm">
              {database.migrations.map((migration) => (
                <li key={migration}>{migration}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </CardContent>
  </Card>
);

const Release = () => {
  const release = Route.useLoaderData();
  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <Link
          to="/releases"
          className="text-muted-foreground text-sm underline-offset-4 hover:underline"
        >
          Releases
        </Link>
        <h1 className="font-mono text-2xl font-medium">{release.id}</h1>
        <p>{release.notes}</p>
      </div>
      <Facts
        facts={[
          ["Commit", release.commitSha],
          ["Built (UTC)", formatTime(release.builtAt)],
          ["Imported (UTC)", formatTime(release.importedAt)],
          ["Manifest SHA-256", release.manifestSha256],
          ["Compatibility date", release.compatibilityDate],
          ["Wrangler", release.wranglerVersion],
        ]}
      />
      {release.workers.map((worker) => (
        <WorkerCard key={worker.app} worker={worker} />
      ))}
      <Card>
        <CardHeader>
          <CardTitle>Packages</CardTitle>
        </CardHeader>
        <CardContent>
          <Facts facts={Object.entries(release.packages)} />
        </CardContent>
      </Card>
    </main>
  );
};

export const Route = createFileRoute("/releases/$releaseId")({
  loader: async ({ params }) => {
    const id = releaseIdSchema.safeParse(params.releaseId);
    const release = id.success
      ? await fetchRelease({ data: { id: id.data } })
      : null;
    if (release === null) {
      throw notFound();
    }
    return release;
  },
  component: Release,
});
