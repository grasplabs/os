CREATE TABLE `memory_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`path` text NOT NULL,
	`base_version` integer NOT NULL,
	`text` text NOT NULL,
	`message` text,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_proposals_status_idx` ON `memory_proposals` (`status`,`created_at`);