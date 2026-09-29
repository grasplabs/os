import {
  createRootRoute,
  HeadContent,
  Link,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import styles from "../styles.css?url";

const RootDocument = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <head>
      <HeadContent />
    </head>
    <body>
      <nav aria-label="Console" className="flex gap-4 border-b px-6 py-3">
        <Link
          to="/"
          activeOptions={{ exact: true }}
          activeProps={{ className: "font-medium" }}
        >
          Clients
        </Link>
        <Link to="/releases" activeProps={{ className: "font-medium" }}>
          Releases
        </Link>
        <Link to="/rollouts" activeProps={{ className: "font-medium" }}>
          Rollouts
        </Link>
      </nav>
      {children}
      <Scripts />
    </body>
  </html>
);

/** A page the console doesn't have. */
const NotFound = () => (
  <main className="flex flex-col gap-4 p-6">
    <h1 className="text-2xl font-medium">Not found</h1>
    <p className="text-sm">The console has no such page.</p>
    <Link to="/" className="text-sm underline underline-offset-4">
      Back to clients
    </Link>
  </main>
);

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Grasp console" },
    ],
    links: [{ rel: "stylesheet", href: styles }],
  }),
  shellComponent: RootDocument,
  notFoundComponent: NotFound,
});
