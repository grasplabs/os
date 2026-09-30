CREATE TABLE `guest_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`permission_id` text NOT NULL,
	`invited_by` text NOT NULL,
	`name` text NOT NULL,
	`skill` text NOT NULL,
	`model` text NOT NULL,
	`token_hash` text NOT NULL,
	`turns` integer NOT NULL,
	`busy_until` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`opened_at` integer,
	`ended_at` integer,
	`ended` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_chats_token_idx` ON `guest_chats` (`token_hash`);--> statement-breakpoint
CREATE INDEX `guest_chats_app_idx` ON `guest_chats` (`app_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `guest_chats_open_idx` ON `guest_chats` (`app_id`,`created_at`,`id`) WHERE ended IS NULL;--> statement-breakpoint
CREATE INDEX `guest_chats_expires_idx` ON `guest_chats` (`expires_at`);--> statement-breakpoint
CREATE TABLE `guest_messages` (
	`chat_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `seq`),
	FOREIGN KEY (`chat_id`) REFERENCES `guest_chats`(`id`) ON UPDATE no action ON DELETE cascade
);
