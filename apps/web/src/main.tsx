import "./zod-jitless.ts";
import "./styles.css";
import { CSPProvider } from "@base-ui/react/csp-provider";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { routeTree } from "./routeTree.gen.ts";

const router = createRouter({ routeTree });

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
