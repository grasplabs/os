import { Badge } from "@grasp-os/ui/components/badge";
import { buttonVariants } from "@grasp-os/ui/components/button";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { withSession, withTimeout } from "../core.ts";

// The nav's way to the person's notifications, with how many are unread,
// read again on every page the person opens. Only while core lists them:
// switched off (or out of reach), the nav leaves it out.

/**
 * How many of the person's notifications are unread; `undefined` when
 * core doesn't list them. Outside the component, as the React Compiler
 * can't compile `try`.
 */
const readUnread = async (): Promise<number | undefined> => {
  try {
    const { unread } = await withSession(
      async (session) => await withTimeout(session.notifications.list())
    );
    return unread;
  } catch {
    return undefined;
  }
};

/** The nav's Notifications entry, with its unread count. */
export const NotificationsLink = () => {
  const router = useRouter();
  const [unread, setUnread] = useState<number>();
  useEffect(() => {
    // Each read's number: only the latest one's count is shown.
    let latest = 0;
    const read = async (): Promise<void> => {
      latest += 1;
      const mine = latest;
      const count = await readUnread();
      if (mine === latest) {
        setUnread(count);
      }
    };
    void read();
    // Again once each page has loaded: the Notifications page reads them
    // all first.
    const unsubscribe = router.subscribe("onResolved", () => {
      void read();
    });
    return () => {
      // Nothing read after this is shown.
      latest += 1;
      unsubscribe();
    };
  }, [router]);
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
