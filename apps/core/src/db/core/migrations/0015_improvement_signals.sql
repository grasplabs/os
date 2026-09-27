CREATE TABLE `improvement_signal_computations` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `improvement_signal_computations_day_idx` ON `improvement_signal_computations` (`day`);--> statement-breakpoint
CREATE INDEX `improvement_signal_computations_started_idx` ON `improvement_signal_computations` (`started_at`);--> statement-breakpoint
CREATE TABLE `improvement_signals` (
	`computation` text NOT NULL,
	`app_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`value` real NOT NULL,
	`evidence` text NOT NULL,
	PRIMARY KEY(`computation`, `app_id`, `workflow_id`, `kind`, `subject`),
	FOREIGN KEY (`computation`) REFERENCES `improvement_signal_computations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `improvement_signals_kind_idx` ON `improvement_signals` (`computation`,`kind`,`value`);--> statement-breakpoint
CREATE INDEX `workflow_decisions_status_opened_idx` ON `workflow_decisions` (`status`,`opened_at`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_decisions_decided_idx` ON `workflow_decisions` (`decided_at`,`id`);--> statement-breakpoint
CREATE INDEX `workflow_runs_status_ended_idx` ON `workflow_runs` (`status`,`ended_at`,`id`);