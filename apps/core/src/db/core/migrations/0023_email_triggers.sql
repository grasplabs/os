ALTER TABLE `workflow_triggers` ADD `address` text;--> statement-breakpoint
CREATE INDEX `workflow_triggers_address_idx` ON `workflow_triggers` (`address`);