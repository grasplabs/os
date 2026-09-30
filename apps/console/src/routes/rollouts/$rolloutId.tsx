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
  checkRevocationFn,
  cancelRolloutFn,
  fetchRollout,
  pauseRolloutFn,
  resumeRolloutFn,
  rollbackClientFn,
  rollbackRingFn,
} from "../../rollout/functions.ts";
import type { RolloutChange } from "../../rollout/functions.ts";
import type { RolloutView, TargetView } from "../../rollout/queries.ts";
import type {
  RevocationCheck,
  RevocationRefusal,
} from "../../rollout/shared-secrets.ts";
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

/** Why a rotated secret's old value must be kept, in words; null when it can go. */
const keepReason = (check: RevocationCheck, name: string): string | null => {
  if (check.storeChanged.includes(name)) {
    return `Keep the old ${name}: Secrets Store changed it again since this rollout started, so roll that out first.`;
  }
  const behind = check.behind[name] ?? [];
  if (behind.length > 0) {
    return `Keep the old ${name}: ${behind.join(", ")} ${behind.length === 1 ? "isn't" : "aren't"} known to run the new value yet. Active clients are read live, and one that doesn't answer, or is still being provisioned, counts.`;
  }
  return null;
};

/** What a revocation check says, secret by secret, then what else it found, in words. */
const checkLines = (check: RevocationCheck): string[] => [
  ...(check.rotated.length === 0
    ? [
        "Secrets Store held what the clients this rollout reached already ran: it hasn't changed, so deploy-ops may not have run, and there's nothing to revoke yet.",
      ]
    : []),
  ...(check.revocable.length === 0
    ? []
    : [
        `The old ${check.revocable.join(", ")} can be revoked at ${check.revocable.length === 1 ? "its provider" : "their providers"}: every active client runs the new value, read live, and none is still being provisioned.`,
      ]),
  ...check.rotated.flatMap((name) => {
    const reason = keepReason(check, name);
    return reason === null ? [] : [reason];
  }),
  ...check.storeChanged
    .filter((name) => !check.rotated.includes(name))
    .map(
      (name) =>
        `Secrets Store changed ${name} since this rollout started: roll it out first.`
    ),
  ...(check.unproven.length === 0
    ? []
    : [
        `What ${check.unproven.join(", ")} ran before isn't on record, so the rotation can't be told from them.`,
      ]),
  ...(check.skipped.length === 0
    ? []
    : [
        `This rollout skipped ${check.skipped.map(({ clientId, reason }) => `${clientId} (${reason})`).join(", ")}.`,
      ]),
  ...(check.outOfScope.length === 0
    ? []
    : [`Outside its scope: ${check.outOfScope.join(", ")}.`]),
];

/** Rollout `rolloutId`'s revocation check, or `failed` when it couldn't be read. Never throws. */
const readRevocation = async (
  rolloutId: string
): Promise<RevocationCheck | RevocationRefusal | "failed"> => {
  try {
    return await checkRevocationFn({ data: { rolloutId } });
  } catch {
    return "failed";
  }
};

/** A revocation check, or why none could be made, in words. */
const verdictOf = (
  result: RevocationCheck | RevocationRefusal | "failed"
): { safe: boolean; lines: string[] } => {
  if (result === "failed") {
    return { safe: false, lines: ["That did not work. Try again."] };
  }
  if (result === "store_unreadable") {
    return {
      safe: false,
      lines: [
        "Secrets Store is missing a shared secret, so nothing can be told.",
      ],
    };
  }
  if (result === "not_secrets_rollout") {
    return { safe: false, lines: ["This isn't a secrets rollout."] };
  }
  // Safe only when every secret it rotated can go: anything else is a
  // warning, whatever else can.
  return {
    safe:
      result.rotated.length > 0 &&
      result.revocable.length === result.rotated.length,
    lines: checkLines(result),
  };
};

/**
 * Whether a secrets rollout's old shared secrets can be revoked at their
 * providers, read live from every active client when staff ask
 * (src/rollout/shared-secrets.ts).
 */
const Revocation = ({ rolloutId }: { rolloutId: string }) => {
  const [verdict, setVerdict] = useState<{
    safe: boolean;
    lines: string[];
  } | null>(null);
  const [reading, setReading] = useState(false);
  const check = async () => {
    setReading(true);
    const result = await readRevocation(rolloutId);
    setReading(false);
    setVerdict(verdictOf(result));
  };
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          variant="outline"
          disabled={reading}
          onClick={() => {
            void check();
          }}
        >
          Check whether the old secrets can be revoked
        </Button>
      </div>
      {verdict === null ? null : (
        <div
          role={verdict.safe ? undefined : "alert"}
          className={
            verdict.safe
              ? "flex flex-col gap-1 text-sm"
              : "text-destructive flex flex-col gap-1 text-sm"
          }
        >
          {verdict.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
};

/** A rollback staff asked for: of one client, or of a ring. */
type PendingRollback =
  | { clientId: string; ring?: never }
  | { ring: number; clientId?: never };

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
  const rollBackClient = (clientId: string) => {
    act(
      async () =>
        await rollbackClientFn({
          data: { rolloutId: rollout.id, clientId },
        })
    );
  };
  // A secrets rollout's rollback puts the old shared secrets back, which
  // may be revoked at their providers already: asked first.
  const [confirming, setConfirming] = useState<PendingRollback | null>(null);
  const runRollback = (pending: PendingRollback) => {
    setConfirming(null);
    if (pending.ring === undefined) {
      rollBackClient(pending.clientId);
    } else {
      rollBackRing(pending.ring);
    }
  };
  const rollBack = (pending: PendingRollback) => {
    if (rollout.kind === "secrets") {
      setConfirming(pending);
    } else {
      runRollback(pending);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {confirming === null ? null : (
        <div
          role="alert"
          className="border-destructive flex flex-col gap-2 rounded-md border p-4 text-sm"
        >
          <p>
            {`Rolling ${confirming.ring === undefined ? confirming.clientId : `ring ${confirming.ring}`} back puts the shared secrets it ran before back. If you revoked them at their providers, its people can't sign in or reach their connections until the next secrets rollout.`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                runRollback(confirming);
              }}
            >
              Roll back anyway
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setConfirming(null);
              }}
            >
              Keep the new secrets
            </Button>
          </div>
        </div>
      )}
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
                    rollBack({ ring });
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
                            rollBack({ clientId: target.clientId });
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
    [
      "Release",
      rollout.kind === "secrets"
        ? "Secrets only, on each client's own release"
        : (rollout.releaseId ?? ""),
    ],
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
      {rollout.kind === "secrets" ? (
        <Revocation rolloutId={rollout.id} />
      ) : null}
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
