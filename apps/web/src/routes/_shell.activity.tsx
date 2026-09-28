import { isAdmin } from "@grasp-os/shared/roles";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
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

const Activity = () => {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const navigate = useNavigate();
  const { tab: _tab, ...filters } = search;
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">Activity</h1>
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
          <TabsTrigger value="log">Audit log</TabsTrigger>
          <TabsTrigger value="pending">Pending approvals</TabsTrigger>
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
                  key={JSON.stringify(filters)}
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
  validateSearch: (search: Record<string, unknown>): ActivitySearch =>
    search.tab === "pending" ? { tab: "pending" } : logSearchOf(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    if (deps.tab === "pending") {
      return {
        tab: "pending" as const,
        pending: await loadFromCore(readPendingRequests),
      };
    }
    return {
      tab: "log" as const,
      log: await loadFromCore(async (session) => await readLog(session, deps)),
    };
  },
  component: Activity,
});
