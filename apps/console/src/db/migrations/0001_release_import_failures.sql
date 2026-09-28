CREATE TABLE `release_import_failures` (
	`release_id` text PRIMARY KEY NOT NULL,
	`attempts` integer NOT NULL,
	`failed_at` integer NOT NULL,
	`next_attempt_at` integer NOT NULL
);
