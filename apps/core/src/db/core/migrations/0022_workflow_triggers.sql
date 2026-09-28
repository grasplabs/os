CREATE TABLE `workflow_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`workflow_id` text NOT NULL,
	`position` integer NOT NULL,
	`type` text NOT NULL,
	`param` text,
	`cron` text,
	`time_zone` text,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_triggers_position_idx` ON `workflow_triggers` (`app_id`,`version`,`workflow_id`,`position`);--> statement-breakpoint
CREATE INDEX `workflow_triggers_next_run_idx` ON `workflow_triggers` (`next_run_at`);--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `trigger_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_runs_trigger_key_idx` ON `workflow_runs` (`trigger_key`);