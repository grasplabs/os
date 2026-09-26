CREATE TABLE `audit_outbox_rejected` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`event` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	`rejected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_outbox_rejected_id` ON `audit_outbox_rejected` (`id`);