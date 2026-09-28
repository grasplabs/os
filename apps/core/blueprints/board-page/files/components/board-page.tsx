import { Badge } from "@grasp-os/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import type { ReactNode } from "react";

import {
  beforeAndAfter,
  formatHours,
  headlineOf,
  maturityLevels,
  signalRows,
  topByHours,
} from "./board";
import type { SnapshotRecord, WorkflowFigures } from "./board";

/** A section of the page, with its heading. */
const Section = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section
    aria-label={title}
    className="flex break-inside-avoid flex-col gap-2"
  >
    <h3 className="text-sm font-medium">{title}</h3>
    {children}
  </section>
);

/** Text cut to two lines in print, where the page must fit one sheet. */
const Clamped = ({ children }: { children: ReactNode }) => (
  <span className="print:line-clamp-2">{children}</span>
);

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground text-sm">{children}</p>
);

const Headline = ({ workflows }: { workflows: WorkflowFigures[] }) => {
  const headline = headlineOf(workflows);
  return (
    <dl aria-label="Headline" className="grid grid-cols-3 gap-4">
      <div>
        <dt className="text-muted-foreground text-xs">Hours a week, now</dt>
        <dd className="text-2xl font-semibold">
          {formatHours(headline.hoursNow)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-xs">Saved a week, running</dt>
        <dd className="text-2xl font-semibold">
          {formatHours(headline.savedRunning)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-xs">Workflows running</dt>
        <dd className="text-2xl font-semibold">
          {headline.running} of {headline.workflows}
        </dd>
      </div>
    </dl>
  );
};

const WhereTheHoursGo = ({ workflows }: { workflows: WorkflowFigures[] }) => {
  const rows = topByHours(workflows);
  if (rows.length === 0) {
    return <Empty>No workflow has hours yet.</Empty>;
  }
  return (
    <Table aria-label="Where the hours go">
      <TableHeader>
        <TableRow>
          <TableHead>Workflow</TableHead>
          <TableHead>Team</TableHead>
          <TableHead className="text-right">Hours a week</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.path}>
            <TableCell className="whitespace-normal">
              <Clamped>{row.title}</Clamped>
            </TableCell>
            <TableCell className="whitespace-normal">
              <Clamped>{row.team ?? ""}</Clamped>
            </TableCell>
            <TableCell className="text-right">
              {formatHours(row.hoursPerWeek)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

const BeforeAndAfter = ({ workflows }: { workflows: WorkflowFigures[] }) => {
  const rows = beforeAndAfter(workflows);
  if (rows.length === 0) {
    return <Empty>No workflow is designed yet.</Empty>;
  }
  return (
    <Table aria-label="Before and after">
      <TableHeader>
        <TableRow>
          <TableHead>Workflow</TableHead>
          <TableHead className="text-right">Drawn</TableHead>
          <TableHead className="text-right">After</TableHead>
          <TableHead>From</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.path}>
            <TableCell className="whitespace-normal">
              <Clamped>{row.title}</Clamped>
            </TableCell>
            <TableCell className="text-right">
              {formatHours(row.before)}
            </TableCell>
            <TableCell className="text-right">
              {formatHours(row.after)}
            </TableCell>
            <TableCell>
              <Badge variant={row.from === "observed" ? "default" : "outline"}>
                {row.from}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
};

/**
 * One snapshot as a page for the board, from what it froze: maturity,
 * where the hours go, before and after, improvement signals, the decision
 * it asks for and its narrative. Each list is cut short, and in print each
 * title, the decision and the narrative are cut to a few lines, so it
 * prints on one page whatever the snapshot holds.
 */
export const BoardPage = ({
  snapshot,
  narrative,
}: {
  snapshot: SnapshotRecord;
  narrative: string;
}) => {
  const workflows = snapshot.figures?.workflows ?? [];
  const signals = signalRows(snapshot.figures?.signals ?? [], workflows);
  return (
    <article
      aria-label="Board page"
      className="flex flex-col gap-5 print:gap-3"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col">
          <h2 className="text-xl font-semibold">{snapshot.title}</h2>
          <p className="text-muted-foreground text-sm">
            As of {snapshot.date}
            {snapshot.figures === undefined
              ? ""
              : `, runs of the ${snapshot.figures.windowDays} days before`}
          </p>
        </div>
        {snapshot.maturity === undefined ? null : (
          <Badge variant="secondary">
            Maturity {snapshot.maturity} of {maturityLevels}
          </Badge>
        )}
      </header>
      {snapshot.figures === undefined ? (
        <Empty>
          This snapshot was saved by hand and froze no numbers. Take one here to
          see them.
        </Empty>
      ) : (
        <>
          <Headline workflows={workflows} />
          <div className="grid gap-5 md:grid-cols-2 print:grid-cols-2 print:gap-3">
            <Section title="Where the hours go">
              <WhereTheHoursGo workflows={workflows} />
            </Section>
            <Section title="Before and after">
              <BeforeAndAfter workflows={workflows} />
            </Section>
          </div>
          <Section title="Improvement signals">
            {signals.length === 0 ? (
              <Empty>No signals from running workflows.</Empty>
            ) : (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {signals.map((signal) => (
                  <li key={signal.key}>
                    <Clamped>
                      <span className="font-medium">{signal.workflow}:</span>{" "}
                      {signal.text}
                    </Clamped>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
      <Section title="Decision needed">
        {snapshot.decisionNeeded === undefined ? (
          <Empty>None yet.</Empty>
        ) : (
          <p className="text-sm font-medium print:line-clamp-3">
            {snapshot.decisionNeeded}
          </p>
        )}
      </Section>
      {narrative.trim() === "" ? null : (
        <Section title="Narrative">
          <p className="text-sm whitespace-pre-line print:line-clamp-6">
            {narrative}
          </p>
        </Section>
      )}
    </article>
  );
};
