CREATE TABLE `upload_cleanups` (
	`key` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text NOT NULL,
	`path` text NOT NULL,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`actor` text NOT NULL,
	`status` text NOT NULL,
	`failure` text,
	`document_id` text,
	`version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `uploads_path_idx` ON `uploads` (`collection_id`,`path`,`created_at`);--> statement-breakpoint
CREATE INDEX `uploads_original_idx` ON `uploads` (`collection_id`,`sha256`);--> statement-breakpoint
CREATE INDEX `uploads_status_idx` ON `uploads` (`status`,`updated_at`);