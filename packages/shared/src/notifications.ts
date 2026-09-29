import { defineErrorFamily } from "./errors.ts";

/** Why a call on notifications was refused. */
export const notificationErrors = defineErrorFamily({
  "notification.invalid": "Those aren't notifications as the list showed them.",
});

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

/**
 * Where a page of notifications goes on from: the last one shown, by its
 * time (`at`) and ID. The next page lists those older than it.
 */
export interface NotificationCursor {
  at: string;
  id: string;
}

/** A page of the person's notifications. */
export interface NotificationPage {
  /** At most {@link listedNotifications}, latest first. */
  notifications: Notification[];
  /** How many of all those they can see are unread. */
  unread: number;
  /** Whether older ones follow: list again from the last one's cursor. */
  more: boolean;
}

/** The signed-in person's notifications. */
export interface NotificationsApi {
  /**
   * Their notifications of Apps they can still open, latest first: the
   * latest page, or the page older than `before`.
   */
  list: (before?: NotificationCursor) => Promise<NotificationPage>;
  /**
   * Marks read the notifications `list` showed (their IDs, at most
   * {@link listedNotifications}) as they were shown: each only while its
   * latest failure is no later than `upTo`, the newest `at` shown, so a
   * failure counted on one since leaves it unread.
   */
  markRead: (ids: string[], upTo: string) => Promise<void>;
}
