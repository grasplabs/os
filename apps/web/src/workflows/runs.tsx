import { runsPageSize } from "@grasp-os/shared/workflows";
import type { ListedRun, RunStatus } from "@grasp-os/shared/workflows";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

// Runs as the Workflows page and a workflow's history list them: each
// with where it is, and a run waiting for a decision with a link to where
// it is answered.

const statusLabels: Readonly<Record<RunStatus, MessageDescriptor>> = {
  running: msg`Running`,
  waiting: msg`Waiting for a decision`,
  paused: msg`Paused`,
  completed: msg`Completed`,
  failed: msg`Failed`,
  cancelled: msg`Cancelled`,
};

/** A run's status, in words, in the page's language. */
export const runStatusLabel = (status: RunStatus): string =>
  i18n._(statusLabels[status]);

export const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Who started a run, in words, for the person `me`. */
const startedByOf = ({ startedBy }: ListedRun, me: string): string => {
  if (startedBy.type === "trigger") {
    return i18n._(msg`Automatically`);
  }
  return startedBy.userId === me ? i18n._(msg`You`) : i18n._(msg`Someone else`);
};

/**
 * Where a run is: its status, with the link to the decision it waits for
 * when the person may answer it (core sends it only then), or, for those
 * who see it, why it failed. That reason is the workflow's
 * own text, shown as text. A run whose details were removed, its
 * retention over, says so in place of the reason, which went with them.
 */
const RunStatusCell = ({ run }: { run: ListedRun }) => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1">
      <span>{runStatusLabel(run.status)}</span>
      {run.decision === undefined ? null : (
        <Link
          className="text-sm underline"
          params={{ decision: run.decision }}
          to="/decisions/$decision"
        >
          <Trans>Decide</Trans>
        </Link>
      )}
      {run.failure === undefined || run.detailsRemoved ? null : (
        <span className="text-muted-foreground text-xs">
          {run.failure.step === null
            ? run.failure.error.message
            : t`At ${run.failure.step}: ${run.failure.error.message}`}
        </span>
      )}
      {run.detailsRemoved ? (
        <span className="text-muted-foreground text-xs">
          <Trans>Details removed</Trans>
        </span>
      ) : null}
    </div>
  );
};

/**
 * Runs, in the order core lists them; with each one's workflow and App
 * unless `withWorkflow` is false, as in one workflow's history. `more`
 * says core had more than it sent.
 */
export const RunsTable = ({
  runs,
  more,
  me,
  withWorkflow = true,
}: {
  runs: ListedRun[];
  more: boolean;
  me: string;
  withWorkflow?: boolean;
}) => {
  if (runs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>No runs.</Trans>
      </p>
    );
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {withWorkflow ? (
              <>
                <TableHead>
                  <Trans>Workflow</Trans>
                </TableHead>
                <TableHead>
                  <Trans>App</Trans>
                </TableHead>
              </>
            ) : null}
            <TableHead>
              <Trans>Status</Trans>
            </TableHead>
            <TableHead>
              <Trans>Version</Trans>
            </TableHead>
            <TableHead>
              <Trans>Started by</Trans>
            </TableHead>
            <TableHead>
              <Trans>Started</Trans>
            </TableHead>
            <TableHead>
              <Trans>Ended</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.id}>
              {withWorkflow ? (
                <>
                  <TableCell>
                    <Link
                      className="underline"
                      params={{ app: run.app, workflow: run.workflow }}
                      to="/workflows/$app/$workflow"
                    >
                      {run.workflow}
                    </Link>
                  </TableCell>
                  <TableCell>{run.appName}</TableCell>
                </>
              ) : null}
              <TableCell>
                <RunStatusCell run={run} />
              </TableCell>
              <TableCell>{run.version}</TableCell>
              <TableCell>{startedByOf(run, me)}</TableCell>
              <TableCell>{dateTime.format(new Date(run.createdAt))}</TableCell>
              <TableCell>
                {run.endedAt === null
                  ? "–"
                  : dateTime.format(new Date(run.endedAt))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {more ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Showing the first {runsPageSize} runs of more.</Trans>
        </p>
      ) : null}
    </>
  );
};
