ALTER TABLE `app_versions` ADD `workflows` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `workflow_decisions_run_status_idx` ON `workflow_decisions` (`run_id`,`status`);--> statement-breakpoint
CREATE INDEX `workflow_runs_created_idx` ON `workflow_runs` (`created_at`,`id`);