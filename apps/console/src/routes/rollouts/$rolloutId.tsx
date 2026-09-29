import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  createFileRoute,
  Link,
  notFound,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { formatTime } from "../../releases/format.ts";
import {
  approveRolloutFn,
  cancelRolloutFn,
  fetchRollout,
  pauseRolloutFn,
  resumeRolloutFn,
  rollbackClientFn,
  rollbackRingFn,
} from "../../rollout/functions.ts";
import type { RolloutChange } from "../../rollout/functions.ts";
import type { RolloutView, TargetView } from "../../rollout/queries.ts";
import { useRolloutAction } from "../../rollout/use-action.ts";
import { thenRefresh } from "../../use-action.ts";

/** How often the page reads the rollout again while it's going. */
const refreshMs = 5000;

/**
 * A target's statuses once a step of the rollout started on it: what a
 * rollback can undo, if its traffic moved (src/rollout/rollback.ts).
 */
const reached: ReadonlySet<TargetView["status"]> = new Set([
  "deploying",
  "done",
  "failed",
  "stopped",
]);

/** A rollout's run statuses in which staff can pause it. */
const pausable: ReadonlySet<RolloutView["run"]> = new Set([
  "queued",
  "running",
  "waiting",
]);

/** What the rollout is doing, in words, from its status and its run's. */
const statusOf = (rollout: RolloutView): string => {
  if (rollout.run === "paused") {
    return "paused";
  }
  if (rollout.status === "waiting") {
    return `waiting for approval after ring ${rollout.ring}`;
  }
  if (rollout.status === "running") {
    return `rolling out to ring ${rollout.ring}`;
  }
  return rollout.status;
};

/**
 * Runs a change and reads the page again, whether it worked or not: a
 * control's action.
 */
const useControl = () => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  const act = (change: () => Promise<RolloutChange<unknown>>) => {
    void run(
      async () =>
        await thenRefresh(change, async () => {
          await router.invalidate({ sync: true });
        })
    );
  };
  return { busy, failure, act };
};

const Controls = ({ rollout }: { rollout: RolloutView }) => {
  const { busy, failure, act } = useControl();
  const data = { rolloutId: rollout.id };
  const active = rollout.status === "running" || rollout.status === "waiting";
  const waiting = rollout.status === "waiting" && rollout.run !== "paused";
  return (
    <div className="flex flex-wrap items-center gap-4">
      {waiting ? (
        <Button
          disabled={busy}
          onClick={() => {
            act(async () => await approveRolloutFn({ data }));
          }}
        >
          Approve the next ring
        </Button>
      ) : null}
      {active && pausable.has(rollout.run) ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            act(async () => await pauseRolloutFn({ data }));
          }}
        >
          Pause
        </Button>
      ) : null}
      {rollout.run === "paused" ? (
        <Button
          disabled={busy}
          onClick={() => {
            act(async () => await resumeRolloutFn({ data }));
          }}
        >
          Resume
        </Button>
      ) : null}
      {rollout.status === "waiting" ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            act(async () => await cancelRolloutFn({ data }));
          }}
        >
          Cancel
        </Button>
      ) : null}
      {failure === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      )}
    </div>
  );
};

/** The rollout's clients, ring by ring, each rolled back on its own or with its ring. */
const Targets = ({ rollout }: { rollout: RolloutView }) => {
  const { busy, failure, act } = useControl();
  // The clients a ring's rollback left, and why: the rest were rolled back.
  const [left, setLeft] = useState<string | null>(null);
  const rings = [...new Set(rollout.targets.map(({ ring }) => ring))];
  const rollBackRing = (ring: number) => {
    setLeft(null);
    act(async () => {
      const result = await rollbackRingFn({
        data: { rolloutId: rollout.id, ring },
      });
      const refused = (result.done ?? []).filter(
        ({ refused: code }) => code !== null
      );
      if (refused.length > 0) {
        setLeft(
          `Not rolled back: ${refused
            .map(({ clientId, refused: code }) => `${clientId} (${code ?? ""})`)
            .join(", ")}.`
        );
      }
      return result;
    });
  };
  return (
    <div className="flex flex-col gap-4">
      {failure === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      )}
      {left === null ? null : (
        <p role="alert" className="text-destructive text-sm">
          {left}
        </p>
      )}
      {rings.map((ring) => {
        const targets = rollout.targets.filter(
          (target) => target.ring === ring
        );
        return (
          <section key={ring} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-lg font-medium">{`Ring ${ring}`}</h2>
              {targets.some(({ status }) => reached.has(status)) ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    rollBackRing(ring);
                  }}
                >
                  {`Roll back ring ${ring}`}
                </Button>
              ) : null}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Why</TableHead>
                  <TableHead>Updated (UTC)</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {targets.map((target) => (
                  <TableRow key={target.clientId}>
                    <TableCell>
                      <Link
                        to="/clients/$clientId"
                        params={{ clientId: target.clientId }}
                        className="font-mono underline-offset-4 hover:underline"
                      >
                        {target.clientId}
                      </Link>
                    </TableCell>
                    <TableCell>{target.status}</TableCell>
                    <TableCell>
                      <span className="font-mono">{target.error ?? ""}</span>
                    </TableCell>
                    <TableCell>{formatTime(target.updatedAt)}</TableCell>
                    <TableCell>
                      {reached.has(target.status) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            act(
                              async () =>
                                await rollbackClientFn({
                                  data: {
                                    rolloutId: rollout.id,
                                    clientId: target.clientId,
                                  },
                                })
                            );
                          }}
                        >
                          Roll back
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        );
      })}
    </div>
  );
};

const Rollout = () => {
  const rollout = Route.useLoaderData();
  const router = useRouter();
  const going = rollout.status === "running" || rollout.status === "waiting";
  useEffect(() => {
    const timer = going
      ? setInterval(() => {
          void router.invalidate();
        }, refreshMs)
      : undefined;
    return () => {
      clearInterval(timer);
    };
  }, [going, router]);
  const facts: [string, string][] = [
    ["Release", rollout.releaseId ?? ""],
    ["Started by", rollout.startedBy],
    ["Started (UTC)", formatTime(rollout.createdAt)],
  ];
  return (
    <main className="flex max-w-4xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-medium">Rollout</h1>
        <Badge
          variant={rollout.status === "failed" ? "destructive" : "secondary"}
        >
          {statusOf(rollout)}
        </Badge>
      </div>
      <dl className="flex flex-col gap-1 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="flex flex-wrap gap-x-4">
            <dt className="text-muted-foreground w-48">{term}</dt>
            <dd className="font-mono break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <Controls rollout={rollout} />
      <Targets rollout={rollout} />
    </main>
  );
};

/** A rollout id that names no rollout. */
const NoSuchRollout = () => (
  <main className="flex flex-col gap-4 p-6">
    <h1 className="text-2xl font-medium">No such rollout</h1>
    <Link to="/rollouts" className="text-sm underline underline-offset-4">
      Back to rollouts
    </Link>
  </main>
);

export const Route = createFileRoute("/rollouts/$rolloutId")({
  loader: async ({ params }) => {
    if (!z.uuid().safeParse(params.rolloutId).success) {
      throw notFound();
    }
    const rollout = await fetchRollout({
      data: { rolloutId: params.rolloutId },
    });
    if (rollout === null) {
      throw notFound();
    }
    return rollout;
  },
  component: Rollout,
  notFoundComponent: NoSuchRollout,
});
