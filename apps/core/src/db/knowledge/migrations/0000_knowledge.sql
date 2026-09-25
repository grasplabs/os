CREATE TABLE `audit_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `collection_teams` (
	`collection_id` text NOT NULL,
	`team_id` text NOT NULL,
	PRIMARY KEY(`collection_id`, `team_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collection_teams_team_id_idx` ON `collection_teams` (`team_id`);--> statement-breakpoint
CREATE TABLE `collections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`owner` text NOT NULL,
	`access` text NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`source` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`description` text NOT NULL,
	`owner` text NOT NULL,
	`tags` text NOT NULL,
	`review_date` text,
	`current_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_collection_path_idx` ON `documents` (`collection_id`,`path`);--> statement-breakpoint
CREATE TABLE `links` (
	`from_document_id` text NOT NULL,
	`to_collection_id` text NOT NULL,
	`to_path` text NOT NULL,
	`label` text,
	PRIMARY KEY(`from_document_id`, `to_collection_id`, `to_path`),
	FOREIGN KEY (`from_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `links_to_idx` ON `links` (`to_collection_id`,`to_path`);--> statement-breakpoint
CREATE TABLE `sections` (
	`document_id` text NOT NULL,
	`version` integer NOT NULL,
	`position` integer NOT NULL,
	`headings` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`document_id`, `position`),
	FOREIGN KEY (`document_id`,`version`) REFERENCES `versions`(`document_id`,`number`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `versions` (
	`document_id` text NOT NULL,
	`number` integer NOT NULL,
	`text` text NOT NULL,
	`author` text NOT NULL,
	`message` text,
	`restored_from` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `number`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
