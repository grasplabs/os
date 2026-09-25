CREATE TABLE `app_versions` (
	`app_id` text NOT NULL,
	`version` integer NOT NULL,
	`parent` integer,
	`tree` text NOT NULL,
	`files` integer NOT NULL,
	`author_id` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `version`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `app_working_files` (
	`app_id` text NOT NULL,
	`path` text NOT NULL,
	`blob` text,
	`length` integer NOT NULL,
	`written_by` text NOT NULL,
	`written_at` integer NOT NULL,
	PRIMARY KEY(`app_id`, `path`),
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`owner_id` text NOT NULL,
	`blueprint` text,
	`current_version` integer,
	`pending_version` integer,
	`created_at` integer NOT NULL
);
