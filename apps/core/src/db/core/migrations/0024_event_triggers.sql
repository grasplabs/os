ALTER TABLE `workflow_triggers` ADD `event` text;--> statement-breakpoint
ALTER TABLE `workflow_triggers` ADD `filter` text;--> statement-breakpoint
CREATE INDEX `workflow_triggers_event_idx` ON `workflow_triggers` (`event`);