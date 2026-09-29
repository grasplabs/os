CREATE TABLE `chat_draft_files` (
	`chat_id` text NOT NULL,
	`app_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text,
	PRIMARY KEY(`chat_id`, `app_id`, `path`),
	FOREIGN KEY (`chat_id`,`app_id`) REFERENCES `chat_drafts`(`chat_id`,`app_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `chat_drafts` (
	`chat_id` text NOT NULL,
	`app_id` text NOT NULL,
	`base` integer,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `app_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
