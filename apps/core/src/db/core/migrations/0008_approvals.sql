CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`permission_id` text,
	`app_id` text,
	`workflow_id` text,
	`param` text,
	`value` text,
	`previous` text,
	`approvers` text NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`break_glass` integer DEFAULT false NOT NULL,
	`version` integer,
	`decision` text,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_pending_permission_idx` ON `approvals` (`permission_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_pending_param_idx` ON `approvals` (`app_id`,`workflow_id`,`param`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`,`requested_at`);--> statement-breakpoint
CREATE TABLE `workflow_param_values` (
	`app_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`param` text NOT NULL,
	`value` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	`approval_id` text,
	PRIMARY KEY(`app_id`, `workflow_id`, `param`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
