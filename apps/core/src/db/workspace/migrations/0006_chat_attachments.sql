CREATE TABLE `chat_attachments` (
	`chat_id` text NOT NULL,
	`run_id` text NOT NULL,
	`report` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `run_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
