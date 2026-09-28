import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";

import { formatTime } from "../../releases/format.ts";
import { fetchReleases } from "../../releases/functions.ts";
import type { ReleaseSummary } from "../../releases/queries.ts";

/** Any two releases, compared: a plain GET form, so it needs no script. */
const Compare = ({ releases }: { releases: ReleaseSummary[] }) => (
  <form
    method="get"
    action="/releases/diff"
    className="flex flex-wrap items-center gap-2"
  >
    <Input
      name="from"
      list="release-ids"
      required
      placeholder="From release"
      aria-label="From release"
      className="w-44"
    />
    <Input
      name="to"
      list="release-ids"
      required
      placeholder="To release"
      aria-label="To release"
      className="w-44"
    />
    <datalist id="release-ids">
      {releases.map((release) => (
        <option key={release.id} value={release.id}>
          {release.notes}
        </option>
      ))}
    </datalist>
    <Button type="submit" variant="outline">
      Compare
    </Button>
  </form>
);

const Releases = () => {
  const { releases, more } = Route.useLoaderData();
  return (
    <main className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-medium">Releases</h1>
        {releases.length > 1 ? <Compare releases={releases} /> : null}
      </div>
      {releases.length === 0 ? (
        <p className="text-muted-foreground">
          No releases yet. Every merge to main publishes one, and the console
          imports it within five minutes.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Release</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>Commit</TableHead>
              <TableHead>Built (UTC)</TableHead>
              <TableHead>Changes</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {releases.map((release, index) => {
              const previous = releases[index + 1];
              return (
                <TableRow key={release.id}>
                  <TableCell>
                    <Link
                      to="/releases/$releaseId"
                      params={{ releaseId: release.id }}
                      className="font-mono underline-offset-4 hover:underline"
                    >
                      {release.id}
                    </Link>
                  </TableCell>
                  <TableCell>{release.notes}</TableCell>
                  <TableCell>
                    <span className="font-mono">
                      {release.commitSha.slice(0, 7)}
                    </span>
                  </TableCell>
                  <TableCell>{formatTime(release.builtAt)}</TableCell>
                  <TableCell>
                    {previous === undefined ? null : (
                      <Link
                        to="/releases/diff"
                        search={{ from: previous.id, to: release.id }}
                        className="underline-offset-4 hover:underline"
                      >
                        Since {previous.id}
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {more ? (
        <p className="text-muted-foreground text-sm">
          {`The newest ${releases.length} releases.`}
        </p>
      ) : null}
    </main>
  );
};

export const Route = createFileRoute("/releases/")({
  loader: async () => await fetchReleases(),
  component: Releases,
});
