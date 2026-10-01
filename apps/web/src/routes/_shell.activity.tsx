import type { AuditPage } from "@grasp-os/shared/audit-log";
import { isAdmin } from "@grasp-os/shared/roles";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Trans } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import {
  LogExport,
  LogFilters,
  LogRecords,
  logSearchOf,
  readLog,
} from "../activity/audit-log.tsx";
import type { LogSearch } from "../activity/audit-log.tsx";
import { PendingApprovals, readPendingRequests } from "../activity/pending.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// Activity, for admins: the audit log, and the permission requests waiting
// for an admin. Core checks the role on every call; the nav shows the page
// to admins only. Only the open tab is read: every search of the log is
// itself recorded in it.

type ActivitySearch = LogSearch & { tab?: "pending" };

/**
 * The records' key: their filters and the first page read, so the log read
 * again, with new filters or the same ones, starts from its own first page
 * and drops the older pages loaded under the last.
 */
const logKey = (filters: LogSearch, { records, next }: AuditPage): string =>
  JSON.stringify([filters, records[0]?.seq ?? null, next]);

const Activity = () => {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const navigate = useNavigate();
  const { tab: _tab, ...filters } = search;
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">
        <Trans>Activity</Trans>
      </h1>
      <Tabs
        value={search.tab ?? "log"}
        onValueChange={(tab: string) => {
          void navigate({
            to: "/activity",
            search: tab === "pending" ? { tab: "pending" } : {},
          });
        }}
      >
        <TabsList>
          <TabsTrigger value="log">
            <Trans>Audit log</Trans>
          </TabsTrigger>
          <TabsTrigger value="pending">
            <Trans>Pending approvals</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="log">
          {data.tab === "log" ? (
            <div className="flex flex-col gap-4">
              {/* Filters and records start again from new filters. */}
              <LogFilters key={JSON.stringify(filters)} search={filters} />
              <LogExport search={filters} />
              <NotLoaded page={data.log} />
              {data.log.state === "ready" ? (
                <LogRecords
                  directory={data.log.data.directory}
                  first={data.log.data.page}
                  key={logKey(filters, data.log.data.page)}
                  search={filters}
                />
              ) : null}
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="pending">
          {data.tab === "pending" ? (
            <>
              <NotLoaded page={data.pending} />
              {data.pending.state === "ready" ? (
                <PendingApprovals
                  decides={isAdmin(identity.role) && !identity.staff}
                  pending={data.pending.data}
                />
              ) : null}
            </>
          ) : null}
        </TabsContent>
      </Tabs>
    </main>
  );
};

export const Route = createFileRoute("/_shell/activity")({
  validateSearch: (search: Record<string, unknown>): ActivitySearch => ({
    ...logSearchOf(search),
    tab: search.tab === "pending" ? "pending" : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { core }, deps }) => {
    if (deps.tab === "pending") {
      return {
        tab: "pending" as const,
        pending: await loadFromCore(core, readPendingRequests),
      };
    }
    return {
      tab: "log" as const,
      log: await loadFromCore(
        core,
        async (session) => await readLog(session, deps)
      ),
    };
  },
  component: Activity,
});
