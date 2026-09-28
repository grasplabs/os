import type { AuditActor } from "@grasp-os/shared/audit";
import { auditEventTypeSchema } from "@grasp-os/shared/audit-log";
import type {
  AuditEventType,
  AuditExportFormat,
  AuditFilter,
  AuditPage,
  AuditRecord,
} from "@grasp-os/shared/audit-log";
import { identifierMaxLength } from "@grasp-os/shared/ids";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
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
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { appName, personName, readDirectory } from "./directory.ts";
import type { Directory } from "./directory.ts";

// The audit log, for admins: its events newest first, narrowed by the
// filters in the page's address, a page at a time, each with its details
// and whether it verified, and an export of everything the filters match.
// Core records every search and export in the log itself.

/** The log's filters, as the page's address holds them. */
export interface LogSearch {
  type?: AuditEventType;
  action?: string;
  /** A person's, agent's, App's or run's ID. */
  actor?: string;
  target?: string;
  /** Days (`yyyy-mm-dd`), in the viewer's time zone, both included. */
  from?: string;
  to?: string;
}

const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;

/** A text filter as typed: trimmed, identifier-sized, and none when empty. */
const textFilter = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim().slice(0, identifierMaxLength);
  return text === "" ? undefined : text;
};

/** A day as the date inputs give it, and none for anything else. */
const dayFilter = (value: unknown): string | undefined =>
  typeof value === "string" &&
  dayPattern.test(value) &&
  !Number.isNaN(Date.parse(value))
    ? value
    : undefined;

/** The log's filters in `search`, dropping what isn't one. */
export const logSearchOf = (search: Record<string, unknown>): LogSearch => {
  const type = auditEventTypeSchema.safeParse(search.type).data;
  const fields = {
    type,
    action: textFilter(search.action),
    actor: textFilter(search.actor),
    target: textFilter(search.target),
    from: dayFilter(search.from),
    to: dayFilter(search.to),
  };
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
};

/** Midnight starting `day`, `days` later, in the viewer's time zone. */
const midnight = (day: string, days = 0): string => {
  const date = new Date(`${day}T00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString();
};

/** The filters as core takes them: `to` up to the end of its day. */
export const auditFilterOf = ({
  type,
  action,
  actor,
  target,
  from,
  to,
}: LogSearch): AuditFilter => ({
  type,
  action,
  actorId: actor,
  targetId: target,
  from: from === undefined ? undefined : midnight(from),
  to: to === undefined ? undefined : midnight(to, 1),
});

/** The first page of events that match, with the names to show. */
export interface LogPage {
  page: AuditPage;
  directory: Directory;
}

export const readLog = async (
  session: Session,
  search: LogSearch
): Promise<LogPage> => {
  const [page, directory] = await Promise.all([
    session.audit.search(auditFilterOf(search)),
    readDirectory(session),
  ]);
  return { page, directory };
};

const typeLabels: Record<AuditEventType, string> = {
  read: "Read",
  action: "Action",
  decision: "Decision",
  permission: "Permission",
  model_call: "Model call",
  config: "Configuration",
  platform_update: "Platform update",
};

const anyType = "any";

const typeItems = [
  { label: "Any type", value: anyType },
  ...auditEventTypeSchema.options.map((type) => ({
    label: typeLabels[type],
    value: type,
  })),
];

/** A labelled text or date input of the filter form. */
const Field = ({
  label,
  name,
  type = "text",
  defaultValue,
}: {
  label: string;
  name: keyof LogSearch;
  type?: "text" | "date";
  defaultValue: string | undefined;
}) => (
  <label className="flex flex-col gap-1 text-sm">
    {label}
    <Input
      defaultValue={defaultValue}
      maxLength={identifierMaxLength}
      name={name}
      type={type}
    />
  </label>
);

/**
 * The filters, as the address has them. Applying them puts them in the
 * address, which reads the log again.
 */
export const LogFilters = ({ search }: { search: LogSearch }) => {
  const navigate = useNavigate();
  const [type, setType] = useState<string>(search.type ?? anyType);
  return (
    <form
      aria-label="Filters"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        void navigate({
          to: "/activity",
          search: logSearchOf({ ...Object.fromEntries(form), type }),
        });
      }}
    >
      <div className="flex flex-col gap-1 text-sm">
        <span aria-hidden>Type</span>
        <Select
          items={typeItems}
          value={type}
          onValueChange={(value: string | null) => {
            setType(value ?? anyType);
          }}
        >
          <SelectTrigger aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {typeItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Field defaultValue={search.action} label="Action" name="action" />
      <Field defaultValue={search.actor} label="Actor ID" name="actor" />
      <Field defaultValue={search.target} label="Target ID" name="target" />
      <Field defaultValue={search.from} label="From" name="from" type="date" />
      <Field defaultValue={search.to} label="To" name="to" type="date" />
      <Button type="submit">Filter</Button>
      <Link className="text-sm underline" search={{}} to="/activity">
        Clear
      </Link>
    </form>
  );
};

/**
 * How long a download's blob is kept for the browser to take it: some
 * browsers read it only after the click has returned.
 */
const downloadKeepMs = 60_000;

/** Saves `blob` as a file called `name`, as a download. */
const save = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, downloadKeepMs);
};

/** Everything the filters match, as a download, oldest first. */
export const LogExport = ({ search }: { search: LogSearch }) => {
  const { busy, failure, run } = useCoreAction();
  const exportAs = async (format: AuditExportFormat): Promise<void> => {
    await run(async (session) => {
      // Read in full on the session that asked: core streams it a page at
      // a time, checking the session again before each.
      const stream = await session.audit.export(auditFilterOf(search), format);
      const blob = await new Response(stream).blob();
      const day = new Date().toISOString().slice(0, "yyyy-mm-dd".length);
      save(blob, `audit-log-${day}.${format}`);
    });
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void exportAs("csv");
          }}
        >
          Export CSV
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void exportAs("json");
          }}
        >
          Export JSON
        </Button>
      </div>
      {busy ? <output className="text-sm">Exporting…</output> : null}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/** Who did it, by name where the page knows it, and the ID to filter by. */
const actorOf = (
  actor: AuditActor,
  directory: Directory
): { label: string; id?: string } => {
  if (actor.type === "person") {
    return { label: personName(directory, actor.userId), id: actor.userId };
  }
  if (actor.type === "staff") {
    return {
      label: `${personName(directory, actor.userId)} (Grasp staff)`,
      id: actor.userId,
    };
  }
  if (actor.type === "agent") {
    return {
      label: `Agent ${actor.agentId} for ${personName(directory, actor.onBehalfOf)}`,
      id: actor.agentId,
    };
  }
  if (actor.type === "app") {
    return {
      label: `${appName(directory, actor.appId)} (${actor.part})`,
      id: actor.appId,
    };
  }
  if (actor.type === "workflow") {
    return {
      label: `${appName(directory, actor.appId)}: run of ${actor.workflowId}`,
      id: actor.appId,
    };
  }
  return { label: "Grasp" };
};

const formatTime = (iso: string): string => new Date(iso).toLocaleString();

/** The event as stored, laid out to read; the stored text if it isn't JSON. */
const readable = (json: string): string => {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

const RecordRow = ({
  record,
  directory,
}: {
  record: AuditRecord;
  directory: Directory;
}) => {
  const [open, setOpen] = useState(false);
  const { event } = record;
  const actor = event === null ? undefined : actorOf(event.actor, directory);
  const detailsId = `audit-${record.seq}`;
  return (
    <>
      <TableRow>
        <TableCell>{formatTime(record.receivedAt)}</TableCell>
        <TableCell>{event?.action ?? "Unreadable event"}</TableCell>
        <TableCell>
          {record.type === null ? "–" : typeLabels[record.type]}
        </TableCell>
        <TableCell>
          {actor?.id === undefined ? (
            (actor?.label ?? "–")
          ) : (
            <Link
              className="underline"
              search={{ actor: actor.id }}
              to="/activity"
            >
              {actor.label}
            </Link>
          )}
        </TableCell>
        <TableCell>
          {event?.target === undefined ? (
            "–"
          ) : (
            <Link
              className="underline"
              search={{ target: event.target.id }}
              to="/activity"
            >
              {event.target.type} {event.target.id}
            </Link>
          )}
        </TableCell>
        <TableCell>
          {record.verified ? null : (
            <Badge variant="destructive">Not verified</Badge>
          )}
        </TableCell>
        <TableCell>
          <Button
            variant="ghost"
            size="sm"
            aria-controls={open ? detailsId : undefined}
            aria-expanded={open}
            aria-label={`Details of event ${record.seq}`}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? "Hide" : "Details"}
          </Button>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={7}>
            <dl className="flex flex-col gap-1 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Position</dt>
                <dd>{record.seq}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Verified</dt>
                <dd>
                  {record.verified
                    ? "Yes: its hash matches, and it links to the event before it."
                    : "No: its hash or its link to the event before it doesn't match."}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Hash</dt>
                <dd className="font-mono break-all">{record.hash}</dd>
              </div>
            </dl>
            <pre
              className="bg-muted mt-2 overflow-x-auto rounded-md p-3 text-xs"
              id={detailsId}
            >
              {readable(record.eventJson)}
            </pre>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
};

/**
 * The events that match, newest first: the first page as the page read
 * it, then each older page asked for. Keyed by the filters where it's
 * used, so new filters start from their own first page.
 */
export const LogRecords = ({
  first,
  search,
  directory,
}: {
  first: AuditPage;
  search: LogSearch;
  directory: Directory;
}) => {
  const [older, setOlder] = useState<AuditRecord[]>([]);
  const [next, setNext] = useState(first.next);
  const { busy, failure, run } = useCoreAction();
  const records = [...first.records, ...older];
  const loadOlder = async (before: number): Promise<void> => {
    const page = await run(
      async (session) =>
        await session.audit.search(auditFilterOf(search), before)
    );
    if (page !== undefined) {
      setOlder((shown) => [...shown, ...page.records]);
      setNext(page.next);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {records.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {next === null
            ? "No events match."
            : "No events match in the latest stretch of the log."}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>
                <span className="sr-only">Verified</span>
              </TableHead>
              <TableHead>
                <span className="sr-only">Details</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((record) => (
              <RecordRow
                directory={directory}
                key={record.seq}
                record={record}
              />
            ))}
          </TableBody>
        </Table>
      )}
      {next === null ? null : (
        <Button
          className="self-start"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void loadOlder(next);
          }}
        >
          {busy ? "Loading…" : "Load older"}
        </Button>
      )}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
