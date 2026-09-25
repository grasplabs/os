CREATE TABLE `events` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`version` integer NOT NULL,
	`received_at` text NOT NULL,
	`event` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	CONSTRAINT "events_seq_positive" CHECK("events"."seq" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_id_unique` ON `events` (`id`);