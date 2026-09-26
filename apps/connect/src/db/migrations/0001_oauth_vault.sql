CREATE TABLE `connection_tokens` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`sealed` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`generation` integer NOT NULL,
	`refresh_until` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`scope` text NOT NULL,
	`tenant` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_to` text NOT NULL,
	`verifier` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_flows_expires_idx` ON `oauth_flows` (`expires_at`);--> statement-breakpoint
ALTER TABLE `connections` ADD `tenant` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `account_name` text;--> statement-breakpoint
ALTER TABLE `connections` ADD `connected_by` text;--> statement-breakpoint
CREATE UNIQUE INDEX `connections_account_idx` ON `connections` (`provider`,`account_id`) WHERE "connections"."account_id" IS NOT NULL AND "connections"."status" <> 'disconnected';