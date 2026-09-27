CREATE TABLE `app_blueprints` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`marked_by` text NOT NULL,
	`marked_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `version`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
