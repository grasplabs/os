CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`client_id` text,
	`target` text,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_client_idx` ON `audit_events` (`client_id`,`at`);--> statement-breakpoint
CREATE TABLE `client_workers` (
	`client_id` text NOT NULL,
	`worker` text NOT NULL,
	`script_name` text NOT NULL,
	`release_id` text,
	`version_id` text,
	`deployed_at` integer,
	PRIMARY KEY(`client_id`, `worker`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`account_id` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`ring` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'provisioning' NOT NULL,
	`pinned_release_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pinned_release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_account_id_unique` ON `clients` (`account_id`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`commit_sha` text NOT NULL,
	`manifest` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`built_at` integer NOT NULL,
	`imported_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rollout_targets` (
	`rollout_id` text NOT NULL,
	`client_id` text NOT NULL,
	`ring` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`rollout_id`, `client_id`),
	FOREIGN KEY (`rollout_id`) REFERENCES `rollouts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rollout_targets_client_idx` ON `rollout_targets` (`client_id`);--> statement-breakpoint
CREATE TABLE `rollouts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`release_id` text,
	`status` text NOT NULL,
	`ring` integer DEFAULT 0 NOT NULL,
	`started_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `releases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rollouts_status_idx` ON `rollouts` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`client_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`client_id`, `key`),
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `staff` (
	`email` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`entra_oid` text,
	`added_at` integer NOT NULL
);
