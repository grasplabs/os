import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { withTimeout } from "../core.ts";
import { useCore } from "../use-core.ts";

// The nav's way to the person's notifications, with how many are unread,
// read again on every other page the person opens. Only while core lists
// them: switched off (or out of reach), the nav leaves it out.

/**
 * How many of the person's notifications are unread; `undefined` when
 * core doesn't list them. Outside the component, as the React Compiler
 * can't compile `try`.
 */
const readUnread = async (
  core: CoreConnection
): Promise<number | undefined> => {
  try {
    const { unread } = await withTimeout(
      core.withSession(async (session) => await session.notifications.list())
    );
    return unread;
  } catch {
    return undefined;
  }
};

/** The nav's Notifications entry, with its unread count. */
export const NotificationsLink = () => {
  const router = useRouter();
  const core = useCore();
  const [unread, setUnread] = useState<number>();
  useEffect(() => {
    // Each read's number: only the latest one's count is shown.
    let latest = 0;
    const read = async (): Promise<void> => {
      latest += 1;
      const mine = latest;
      const count = await readUnread(core);
      if (mine === latest) {
        setUnread(count);
      }
    };
    void read();
    // Again once another page has loaded (the Notifications page reads
    // them first); not when only the page's search changes.
    const unsubscribe = router.subscribe("onResolved", ({ pathChanged }) => {
      if (pathChanged) {
        void read();
      }
    });
    return () => {
      // Nothing read after this is shown.
      latest += 1;
      unsubscribe();
    };
  }, [router, core]);
  if (unread === undefined) {
    return null;
  }
  return (
    <li>
      <Link
        activeProps={{ className: "bg-muted" }}
        className={buttonVariants({
          variant: "ghost",
          className: "w-full justify-start",
        })}
        to="/notifications"
      >
        Notifications
        {unread > 0 ? (
          <Badge className="ml-auto">
            {unread}
            <span className="sr-only"> unread</span>
          </Badge>
        ) : null}
      </Link>
    </li>
  );
};
