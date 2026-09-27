CREATE TABLE `composio_cleanups` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text,
	`connected_account_id` text,
	`auth_config_id` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `composio_cleanups_retry_idx` ON `composio_cleanups` (`retry_at`);--> statement-breakpoint
CREATE TABLE `composio_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`flow_id` text NOT NULL,
	`user_id` text NOT NULL,
	`toolkit` text NOT NULL,
	`auth_config_id` text NOT NULL,
	`connected_account_id` text NOT NULL,
	`tools` text NOT NULL,
	`return_to` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `composio_flows_expires_idx` ON `composio_flows` (`expires_at`);--> statement-breakpoint
CREATE INDEX `composio_flows_user_id_idx` ON `composio_flows` (`user_id`);--> statement-breakpoint
ALTER TABLE `connections` ADD `composio_server_id` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `composio_auth_config_id` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `tools` text;