import type { AuditActor } from "@grasp-os/shared/audit";
import {
  auditActionPrefixSchema,
  auditExportPath,
  auditEventTypeSchema,
} from "@grasp-os/shared/audit-log";
import type {
  AuditEventType,
  AuditExportFormat,
  AuditFilter,
  AuditPage,
  AuditRecord,
} from "@grasp-os/shared/audit-log";
import { identifierMaxLength } from "@grasp-os/shared/ids";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button, buttonVariants } from "@grasp-os/ui/components/button";
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
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import type { Session } from "../core.ts";
import {
  appName,
  formatTime,
  personName,
  readDirectory,
} from "../directory.ts";
import type { Directory } from "../directory.ts";
import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

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

const daySchema = z.iso.date();

/** A text filter as typed: trimmed, identifier-sized, and none when empty. */
const textFilter = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim().slice(0, identifierMaxLength);
  return text === "" ? undefined : text;
};

const trailingDots = /\.+$/u;

/**
 * An action filter as typed, as core takes it: lower case, without a
 * trailing dot (`Connection.` finds `connection.call`), and none for text
 * that can't start an action, rather than a search core refuses whole.
 */
const actionFilter = (value: unknown): string | undefined => {
  const text = textFilter(value)?.toLowerCase().replace(trailingDots, "");
  return auditActionPrefixSchema.safeParse(text).data;
};

/**
 * A day as the date inputs give it (`yyyy-mm-dd`), and none for anything
 * else, a day no calendar has (`2024-02-30`) included: a date rolls it on
 * into the next month, which the filter would search while showing the
 * day typed.
 */
const dayFilter = (value: unknown): string | undefined =>
  daySchema.safeParse(value).data;

/**
 * The log's filters in `search`, each one `undefined` where the address
 * has none or one that isn't a filter: every key is there, as the router
 * merges what a route validates over the address's own search, and a key
 * left out would keep the address's value.
 */
export const logSearchOf = (search: Record<string, unknown>): LogSearch => ({
  type: auditEventTypeSchema.safeParse(search.type).data,
  action: actionFilter(search.action),
  actor: textFilter(search.actor),
  target: textFilter(search.target),
  from: dayFilter(search.from),
  to: dayFilter(search.to),
});

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

const typeLabels: Record<AuditEventType, MessageDescriptor> = {
  read: msg`Read`,
  action: msg`Action`,
  decision: msg`Decision`,
  permission: msg`Permission`,
  model_call: msg`Model call`,
  config: msg`Configuration`,
  platform_update: msg`Platform update`,
};

const anyType = "any";

/** The types to filter by, in the page's language. */
const typeItems = (): { label: string; value: string }[] => [
  { label: i18n._(msg`Any type`), value: anyType },
  ...auditEventTypeSchema.options.map((type) => ({
    label: i18n._(typeLabels[type]),
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
  const { t } = useLingui();
  const [type, setType] = useState<string>(search.type ?? anyType);
  const types = typeItems();
  return (
    <form
      aria-label={t`Filters`}
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
        <span aria-hidden>
          <Trans>Type</Trans>
        </span>
        <Select
          items={types}
          value={type}
          onValueChange={(value: string | null) => {
            setType(value ?? anyType);
          }}
        >
          <SelectTrigger aria-label={t`Type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {types.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Field defaultValue={search.action} label={t`Action`} name="action" />
      <Field defaultValue={search.actor} label={t`Actor ID`} name="actor" />
      <Field defaultValue={search.target} label={t`Target ID`} name="target" />
      <Field
        defaultValue={search.from}
        label={t`From`}
        name="from"
        type="date"
      />
      <Field defaultValue={search.to} label={t`To`} name="to" type="date" />
      <Button type="submit">
        <Trans>Filter</Trans>
      </Button>
      <Link className="text-sm underline" search={{}} to="/activity">
        <Trans>Clear</Trans>
      </Link>
    </form>
  );
};

/**
 * Where the browser downloads what `search` matches as `format`: core's
 * export route, which it writes to disk as it arrives, however long.
 */
const exportHref = (search: LogSearch, format: AuditExportFormat): string => {
  const params = new URLSearchParams();
  params.set("format", format);
  for (const [name, value] of Object.entries(auditFilterOf(search) ?? {})) {
    if (typeof value === "string") {
      params.set(name, value);
    }
  }
  return `${auditExportPath}?${params.toString()}`;
};

/**
 * Everything the filters match, oldest first, as a download. Core records
 * the export before it sends anything, and checks the session again as it
 * reads each page.
 */
export const LogExport = ({ search }: { search: LogSearch }) => (
  <div className="flex gap-2">
    <a
      className={buttonVariants({ variant: "outline" })}
      href={exportHref(search, "csv")}
    >
      <Trans>Export CSV</Trans>
    </a>
    <a
      className={buttonVariants({ variant: "outline" })}
      href={exportHref(search, "json")}
    >
      <Trans>Export JSON</Trans>
    </a>
  </div>
);

/** Who did it, by name where the page knows it, and the ID to filter by. */
const actorOf = (
  actor: AuditActor,
  directory: Directory
): { label: string; id?: string } => {
  if (actor.type === "person") {
    return { label: personName(directory, actor.userId), id: actor.userId };
  }
  if (actor.type === "staff") {
    const name = personName(directory, actor.userId);
    return { label: i18n._(msg`${name} (Grasp staff)`), id: actor.userId };
  }
  if (actor.type === "agent") {
    const { agentId } = actor;
    const person = personName(directory, actor.onBehalfOf);
    return {
      label: i18n._(msg`Agent ${agentId} for ${person}`),
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
    const app = appName(directory, actor.appId);
    const { workflowId } = actor;
    return {
      label: i18n._(msg`${app}: run of ${workflowId}`),
      id: actor.runId,
    };
  }
  if (actor.type === "guest") {
    const app = appName(directory, actor.appId);
    const person = personName(directory, actor.invitedBy);
    return {
      label: i18n._(msg`Guest of ${app}, invited for ${person}`),
      id: actor.chatId,
    };
  }
  // The platform itself: a name, the same in every language.
  return { label: "Grasp" };
};

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
  const { t } = useLingui();
  const { event } = record;
  const { seq } = record;
  const actor = event === null ? undefined : actorOf(event.actor, directory);
  const detailsId = `audit-${record.seq}`;
  return (
    <>
      <TableRow>
        <TableCell>{formatTime(record.receivedAt)}</TableCell>
        <TableCell>{event?.action ?? t`Unreadable event`}</TableCell>
        <TableCell>
          {record.type === null ? "–" : i18n._(typeLabels[record.type])}
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
            <Badge variant="destructive">
              <Trans>Not verified</Trans>
            </Badge>
          )}
        </TableCell>
        <TableCell>
          <Button
            variant="ghost"
            size="sm"
            aria-controls={open ? detailsId : undefined}
            aria-expanded={open}
            aria-label={t`Details of event ${seq}`}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? t`Hide` : t`Details`}
          </Button>
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow>
          <TableCell colSpan={7}>
            <dl className="flex flex-col gap-1 text-sm">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">
                  <Trans>Position</Trans>
                </dt>
                <dd>{record.seq}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">
                  <Trans>Verified</Trans>
                </dt>
                <dd>
                  {record.verified
                    ? t`Yes: its hash matches, and it links to the event before it.`
                    : t`No: its hash or its link to the event before it doesn't match.`}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">
                  <Trans>Hash</Trans>
                </dt>
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
 * it, then each older page asked for. Keyed by the filters and the first
 * page where it's used, so every new read starts from its own first page.
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
  const { t } = useLingui();
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
            ? t`No events match.`
            : t`No events match in the latest stretch of the log.`}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>
                <Trans>Time</Trans>
              </TableHead>
              <TableHead>
                <Trans>Action</Trans>
              </TableHead>
              <TableHead>
                <Trans>Type</Trans>
              </TableHead>
              <TableHead>
                <Trans>Actor</Trans>
              </TableHead>
              <TableHead>
                <Trans>Target</Trans>
              </TableHead>
              <TableHead>
                <span className="sr-only">
                  <Trans>Verified</Trans>
                </span>
              </TableHead>
              <TableHead>
                <span className="sr-only">
                  <Trans>Details</Trans>
                </span>
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
          {busy ? t`Loading…` : t`Load older`}
        </Button>
      )}
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};
