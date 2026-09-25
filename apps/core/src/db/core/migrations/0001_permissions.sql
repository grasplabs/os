CREATE TABLE `audit_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`resource` text,
	`actions` text NOT NULL,
	`binding` text NOT NULL,
	`status` text NOT NULL,
	`requested_by` text NOT NULL,
	`requested_at` integer NOT NULL,
	`granted_by` text,
	`granted_at` integer,
	`revoked_by` text,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `permissions_subject_idx` ON `permissions` (`subject_type`,`subject_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_live_binding_idx` ON `permissions` (`subject_type`,`subject_id`,`binding`) WHERE status <> 'revoked';