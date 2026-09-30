import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";

import type { CoreConnection } from "../core-connection.ts";

/** What every route gets from the router: the tab's connection to core. */
interface RouterContext {
  core: CoreConnection;
}

const RootLayout = () => <Outlet />;

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});
