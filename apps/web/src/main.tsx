import "./zod-jitless.ts";
import "./styles.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CoreConnection } from "./core-connection.ts";
import { reportError, reportUncaughtErrors } from "./error-reports.ts";
import { RouteError } from "./route-error.tsx";
import { routeTree } from "./routeTree.gen.ts";

// The tab's one connection to core, made once and handed to every route.
// When the person's session ends, the page loads again: the shell finds
// nobody signed in, and sends them to sign in and back to where they were.
const core = new CoreConnection(() => {
  window.location.reload();
});

// Every route shows a failure the same way, and reports a fault of the
// page's own to core (route-error.tsx), the root route included: the
// boundary around the whole app.
const router = createRouter({
  routeTree,
  context: { core },
  defaultErrorComponent: RouteError,
});

// What the page throws and never catches, reported with the route's
// pattern (such as `/apps/$app`), never its URL.
reportUncaughtErrors(() => router.state.matches.at(-1)?.fullPath);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.querySelector("#root");
if (!root) {
  throw new Error("Missing #root element");
}

// What no route's boundary caught, such as a fault in the router itself.
createRoot(root, {
  onUncaughtError: (error) => {
    void reportError("render", error);
  },
}).render(
  <StrictMode>
    {/* The CSP allows no inline <style>, so Base UI renders none of its
        own; styles.css carries the rule they held. */}
    <CSPProvider disableStyleElements>
      <RouterProvider router={router} />
    </CSPProvider>
  </StrictMode>
);
