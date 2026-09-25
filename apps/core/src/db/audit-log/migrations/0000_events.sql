CREATE TABLE `events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`event` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);