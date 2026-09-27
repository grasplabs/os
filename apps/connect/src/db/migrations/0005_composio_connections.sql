CREATE TABLE `composio_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
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
ALTER TABLE `connections` ADD `tools` text;