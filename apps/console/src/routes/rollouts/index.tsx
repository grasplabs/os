import { Button } from "@grasp-os/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { formatTime } from "../../releases/format.ts";
import type { StartRolloutInput } from "../../rollout/control.ts";
import { fetchRollouts, startRolloutFn } from "../../rollout/functions.ts";
import type { RolloutOptions } from "../../rollout/queries.ts";
import type { RolloutScope } from "../../rollout/targets.ts";
import { useRolloutAction } from "../../rollout/use-action.ts";
import { InvalidFieldError } from "../../use-action.ts";

/** What a rollout reaches after ring 0, as the form offers it. */
type ScopeKind = RolloutScope["scope"];

const scopes: { value: ScopeKind; label: string }[] = [
  { value: "ring", label: "One ring" },
  { value: "client", label: "One client" },
  { value: "all", label: "Every client, ring by ring" },
];

/** What a rollout takes to clients, as the form offers it. */
type RolloutKind = StartRolloutInput["kind"];

const kinds: { value: RolloutKind; label: string }[] = [
  { value: "release", label: "A release" },
  { value: "secrets", label: "Secrets only" },
];

/** The form's text field `name`, trimmed. */
const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** The scope the form says, or why it can't be one. */
const scopeOf = (
  kind: ScopeKind,
  ring: number,
  form: FormData
): RolloutScope => {
  if (kind === "all") {
    return { scope: "all" };
  }
  if (kind === "client") {
    const clientId = textOf(form, "clientId");
    if (clientId === "") {
      throw new InvalidFieldError("Name the client to roll out to.");
    }
    return { scope: "client", clientId };
  }
  return { scope: "ring", ring };
};

/** `count` clients, in words. */
const clientsOf = (count: number): string =>
  count === 1 ? "1 client" : `${count} clients`;

/** Starting a rollout: a release or the secrets alone, and whom it reaches after ring 0. */
const StartRollout = ({ options }: { options: RolloutOptions }) => {
  const navigate = useNavigate();
  const { busy, failure, run } = useRolloutAction();
  // Only rings past the first can be chosen: every rollout reaches that
  // one first, whatever else it's for.
  const later = options.rings.filter(({ ring }) => ring !== options.firstRing);
  const [what, setWhat] = useState<RolloutKind>("release");
  const [kind, setKind] = useState<ScopeKind>("ring");
  const [ring, setRing] = useState<number | null>(null);
  const chosenRing = ring ?? later[0]?.ring ?? options.firstRing;
  const ringItems = later.map((each) => ({
    value: each.ring,
    label: `Ring ${each.ring} (${clientsOf(each.clients)})`,
  }));
  const [newest] = options.releases;
  if (newest === undefined) {
    return (
      <p className="text-muted-foreground text-sm">
        No release is imported yet, so there is nothing to roll out.
      </p>
    );
  }
  const start = (form: FormData) => {
    void run(async () => {
      // With no one past the first ring, every client is that ring.
      const scope: RolloutScope =
        later.length === 0 ? { scope: "all" } : scopeOf(kind, chosenRing, form);
      const result = await startRolloutFn({
        data:
          what === "secrets"
            ? { kind: "secrets", scope }
            : { kind: "release", releaseId: textOf(form, "releaseId"), scope },
      });
      if (result.done !== null) {
        await navigate({
          to: "/rollouts/$rolloutId",
          params: { rolloutId: result.done },
        });
      }
      return result;
    });
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        start(new FormData(event.currentTarget));
      }}
      className="flex flex-col gap-4"
    >
      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="font-medium">What</legend>
        <div className="flex flex-wrap gap-2">
          {kinds.map((each) => (
            <Button
              key={each.value}
              type="button"
              size="sm"
              variant={what === each.value ? "default" : "outline"}
              aria-pressed={what === each.value}
              onClick={() => {
                setWhat(each.value);
              }}
            >
              {each.label}
            </Button>
          ))}
        </div>
      </fieldset>
      {what === "secrets" ? (
        <p className="text-muted-foreground text-sm">
          Each client gets the shared secrets in Secrets Store now, on the
          release it runs, all traffic at once. Copy a rotated secret there
          first with the Deploy grasp-os-ops workflow, secrets only.
        </p>
      ) : (
        <label
          htmlFor="rollout-release"
          className="flex flex-col gap-1 text-sm"
        >
          <span className="font-medium">Release</span>
          <Input
            id="rollout-release"
            name="releaseId"
            list="release-ids"
            required
            defaultValue={newest.id}
          />
          <datalist id="release-ids">
            {options.releases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.notes}
              </option>
            ))}
          </datalist>
        </label>
      )}
      {later.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {`Only ring ${options.firstRing} has active clients, so this reaches only our own deployments.`}
        </p>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          <span id="rollout-scope" className="font-medium">
            Then
          </span>
          <Select
            items={scopes}
            value={kind}
            onValueChange={(value: ScopeKind | null) => {
              if (value !== null) {
                setKind(value);
              }
            }}
          >
            <SelectTrigger aria-labelledby="rollout-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {scopes.map((scope) => (
                <SelectItem key={scope.value} value={scope.value}>
                  {scope.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground">
            Ring {options.firstRing} comes first, then this once you approve it.
          </span>
        </div>
      )}
      {later.length > 0 && kind === "all" ? (
        <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
          {options.rings.map((each) => (
            <li key={each.ring}>
              {`Ring ${each.ring}: ${clientsOf(each.clients)}`}
            </li>
          ))}
        </ul>
      ) : null}
      {later.length > 0 && kind === "ring" ? (
        <div className="flex flex-col gap-1 text-sm">
          <span id="rollout-ring" className="font-medium">
            Ring
          </span>
          <Select
            items={ringItems}
            value={chosenRing}
            onValueChange={(value: number | null) => {
              if (value !== null) {
                setRing(value);
              }
            }}
          >
            <SelectTrigger aria-labelledby="rollout-ring">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ringItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {later.length > 0 && kind === "client" ? (
        <label htmlFor="rollout-client" className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Client</span>
          <Input
            id="rollout-client"
            name="clientId"
            list="client-ids"
            required
          />
          <datalist id="client-ids">
            {options.clientIds.map((clientId) => (
              <option key={clientId} value={clientId}>
                {clientId}
              </option>
            ))}
          </datalist>
        </label>
      ) : null}
      <div className="flex items-center gap-4">
        <Button type="submit" disabled={busy}>
          Start rollout
        </Button>
        {failure === null ? null : (
          <p role="alert" className="text-destructive text-sm">
            {failure}
          </p>
        )}
      </div>
    </form>
  );
};

const Rollouts = () => {
  const { rollouts, options } = Route.useLoaderData();
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">Rollouts</h1>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Start a rollout</CardTitle>
        </CardHeader>
        <CardContent>
          <StartRollout options={options} />
        </CardContent>
      </Card>
      {rollouts.length === 0 ? (
        <p className="text-muted-foreground">No rollouts yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started (UTC)</TableHead>
              <TableHead>Release</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Ring</TableHead>
              <TableHead>Started by</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rollouts.map((rollout) => (
              <TableRow key={rollout.id}>
                <TableCell>
                  <Link
                    to="/rollouts/$rolloutId"
                    params={{ rolloutId: rollout.id }}
                    className="underline-offset-4 hover:underline"
                  >
                    {formatTime(rollout.createdAt)}
                  </Link>
                </TableCell>
                <TableCell>
                  {rollout.kind === "secrets" ? (
                    "Secrets only"
                  ) : (
                    <span className="font-mono">{rollout.releaseId ?? ""}</span>
                  )}
                </TableCell>
                <TableCell>{rollout.status}</TableCell>
                <TableCell>{rollout.ring}</TableCell>
                <TableCell>{rollout.startedBy}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
};

export const Route = createFileRoute("/rollouts/")({
  loader: async () => await fetchRollouts(),
  component: Rollouts,
});
