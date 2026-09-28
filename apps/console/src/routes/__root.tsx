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
      </nav>
      {children}
      <Scripts />
    </body>
  </html>
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
});
