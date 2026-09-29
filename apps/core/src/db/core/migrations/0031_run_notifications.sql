CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`type` text NOT NULL,
	`app_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`run_id` text NOT NULL,
	`failures` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `notifications_person_idx` ON `notifications` (`person_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_unread_idx` ON `notifications` (`person_id`,`type`,`app_id`,`workflow_id`) WHERE read_at IS NULL;