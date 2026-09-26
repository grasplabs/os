CREATE TABLE `workflow_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step` text NOT NULL,
	`deciders` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`opened_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decided_via` text,
	`payload` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_decisions_run_step_idx` ON `workflow_decisions` (`run_id`,`step`);