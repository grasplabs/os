import "./zod-jitless.ts";
import "./styles.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CoreConnection } from "./core-connection.ts";
import { routeTree } from "./routeTree.gen.ts";

// The tab's one connection to core, made once and handed to every route.
// When the person's session ends, the page loads again: the shell finds
// nobody signed in, and sends them to sign in and back to where they were.
const core = new CoreConnection(() => {
  window.location.reload();
});

const router = createRouter({ routeTree, context: { core } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.querySelector("#root");
if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    {/* The CSP allows no inline <style>, so Base UI renders none of its
        own; styles.css carries the rule they held. */}
    <CSPProvider disableStyleElements>
      <RouterProvider router={router} />
    </CSPProvider>
  </StrictMode>
);
