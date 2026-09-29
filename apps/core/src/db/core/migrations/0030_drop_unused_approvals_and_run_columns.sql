DROP TABLE `approvals`;--> statement-breakpoint
ALTER TABLE `workflow_decisions` DROP COLUMN `decided_via`;--> statement-breakpoint
ALTER TABLE `workflow_param_values` DROP COLUMN `approval_id`;--> statement-breakpoint
ALTER TABLE `workflow_runs` DROP COLUMN `owner_waits`;--> statement-breakpoint
ALTER TABLE `workflow_runs` DROP COLUMN `acting_for`;