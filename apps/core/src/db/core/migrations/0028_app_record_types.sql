CREATE TABLE `record_type_owners` (
	`collection_id` text NOT NULL,
	`type` text NOT NULL,
	`app_id` text NOT NULL,
	`claimed_at` integer NOT NULL,
	PRIMARY KEY(`collection_id`, `type`)
);
--> statement-breakpoint
ALTER TABLE `app_versions` ADD `records` text DEFAULT '{}' NOT NULL;