import { Button } from "@grasp-os/ui/components/button";
import { SidebarInset, SidebarProvider } from "@grasp-os/ui/components/sidebar";
import { TooltipProvider } from "@grasp-os/ui/components/tooltip";
import { useLingui } from "@lingui/react/macro";
import {
  createFileRoute,
  Outlet,
  redirect,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useState } from "react";

import { loadCoreStatus } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { keepFolded, readFolded } from "../fold.ts";
import { AppSidebar } from "../frame/app-sidebar.tsx";
import { RouteError } from "../route-error.tsx";
import { signInErrorSearch } from "../sign-in-errors.ts";

// The signed-in product: the app's sidebar beside the page, each page
// headed by its own site header (frame/site-header.tsx). Everyone else goes
// to the sign-in page, which sends them back here once they're in.

const Shell = () => {
  const { core, identity } = Route.useRouteContext();
  // Folded as the person left it in this browser.
  const [open, setOpen] = useState(() => readFolded("sidebar") !== true);
  return (
    <TooltipProvider>
      <SidebarProvider
        className="h-svh"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          void keepFolded("sidebar", !next);
        }}
      >
        <AppSidebar core={core} identity={identity} />
        {/* The page scrolls inside it, so its header stays in view. */}
        <SidebarInset className="min-h-0 min-w-0 overflow-y-auto">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
};

/** Core failed or stayed out of reach while the shell asked who is in. */
class CoreUnreachableError extends Error {
  constructor() {
    // Not shown: ShellError says it in the page's language.
    super("Grasp can't be reached right now.");
    this.name = "CoreUnreachableError";
  }
}

/**
 * Says core can't be reached, with a way to ask again (not a fault, so
 * not reported); any other error as every page shows it.
 */
const ShellError = ({ error, reset, info }: ErrorComponentProps) => {
  const router = useRouter();
  const trying = useRouterState({ select: (state) => state.isLoading });
  const { t } = useLingui();
  if (!(error instanceof CoreUnreachableError)) {
    return <RouteError error={error} reset={reset} info={info} />;
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-2xl font-medium">Grasp</h1>
      {/* Gone while trying, so the alert is announced again if it fails. */}
      {trying ? null : (
        <ErrorText>
          {t`Grasp can't be reached right now. Try again in a moment.`}
        </ErrorText>
      )}
      <Button
        variant="outline"
        disabled={trying}
        onClick={() => {
          void router.invalidate();
        }}
      >
        {trying ? t`Trying again…` : t`Try again`}
      </Button>
    </main>
  );
};

export const Route = createFileRoute("/_shell")({
  // Before any page's loader, so each runs for someone signed in, with
  // their identity in its context.
  beforeLoad: async ({ context: { core }, location }) => {
    const { connected, identity } = await loadCoreStatus(core);
    if (!connected) {
      // Nobody can tell who is signed in: sending them to sign in again
      // would say they were signed out.
      throw new CoreUnreachableError();
    }
    if (identity === undefined) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({
        to: "/sign-in",
        search: {
          returnTo: location.pathname,
          // A refused sign-in comes back here, as `error=<code>`.
          ...signInErrorSearch(location.search),
        },
      });
    }
    return { identity };
  },
  component: Shell,
  errorComponent: ShellError,
});
