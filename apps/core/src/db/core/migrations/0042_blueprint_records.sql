CREATE TABLE `blueprints` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`tree` text NOT NULL,
	`app_id` text,
	`version` integer,
	`approved` integer NOT NULL,
	`permissions` text NOT NULL,
	`marked_by` text,
	`marked_at` integer NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blueprints_app_version_idx` ON `blueprints` (`app_id`,`version`);