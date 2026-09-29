CREATE TABLE `connector_events` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`connection_id` text NOT NULL,
	`event` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connector_events_key_idx` ON `connector_events` (`key`);--> statement-breakpoint
CREATE INDEX `connector_events_retry_idx` ON `connector_events` (`retry_at`);--> statement-breakpoint
CREATE INDEX `connector_events_connection_idx` ON `connector_events` (`connection_id`);--> statement-breakpoint
CREATE TABLE `event_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`type` text NOT NULL,
	`resource` text NOT NULL,
	`cursor` text,
	`poll_at` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`read_at` integer,
	`lost_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_sources_key_idx` ON `event_sources` (`connection_id`,`type`,`resource`);--> statement-breakpoint
CREATE INDEX `event_sources_poll_idx` ON `event_sources` (`poll_at`);