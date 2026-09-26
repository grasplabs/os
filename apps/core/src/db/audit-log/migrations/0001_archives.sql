CREATE TABLE `archives` (
	`first_seq` integer PRIMARY KEY NOT NULL,
	`last_seq` integer NOT NULL,
	`prev_hash` text NOT NULL,
	`last_hash` text NOT NULL,
	`last_received_at` text NOT NULL,
	`key` text NOT NULL,
	`archived_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archives_last_seq_unique` ON `archives` (`last_seq`);--> statement-breakpoint
CREATE INDEX `events_received_at_idx` ON `events` (`received_at`);