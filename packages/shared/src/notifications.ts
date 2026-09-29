// What core tells a signed-in person in the product (core's
// notifications.ts): for now, that a workflow failed while acting for
// them. Only they see their own; nobody else is told.

/**
 * A workflow of an App failed while acting for the person: one per App
 * and workflow while unread, counting each failure until it is read.
 */
export interface RunFailedNotification {
  id: string;
  type: "run_failed";
  app: string;
  appName: string;
  workflow: string;
  /** The latest run that failed: the one to ask the agent to fix. */
  run: string;
  /** How many runs failed since it was made. */
  failures: number;
  /** When the latest failed (ISO 8601). */
  at: string;
  read: boolean;
}

export type Notification = RunFailedNotification;

/** Most notifications `list` returns: the latest. */
export const listedNotifications = 50;

/** The signed-in person's notifications. */
export interface NotificationsApi {
  /**
   * Their latest notifications, latest first, of Apps they can still open,
   * and how many of those are unread.
   */
  list: () => Promise<{ notifications: Notification[]; unread: number }>;
  /** Marks all of them read. */
  markRead: () => Promise<void>;
}
