CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`started_by` text,
	`status` text NOT NULL,
	`owner_waits` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_app_idx` ON `workflow_runs` (`app_id`,`created_at`);