CREATE TABLE `chat_sources` (
	`chat_id` text NOT NULL,
	`source_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `source_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
